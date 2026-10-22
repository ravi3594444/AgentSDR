#!/usr/bin/env bash
# Deploy this checkout to the Docker Compose install it lives in (the
# owner's VM), with a database backup, a memory check and a rollback.
#
#   docker/deploy.sh [--branch <branch>] [--yes]
#
# Run it on the VM inside tmux or screen: a dropped SSH connection would stop
# it halfway. In order, it:
#   1. checks git, Docker Compose >= 2.24, the Docker daemon, the compose
#      files, and that MemAvailable + SwapFree covers the image build;
#   2. saves the VM's local edits to $BACKUP_DIR, then fast-forwards the
#      branch. Never reset, never stash: if the update touches an edited
#      file, git refuses and the script stops;
#   3. dumps the database and checks that the dump reads back;
#   4. tags the image the app runs now as agentsdr:rollback-<time>;
#   5. stops the Maps scraper for the build, and starts it again whatever
#      happens;
#   6. builds agentsdr:local, labelled with the commit;
#   7. runs the upgrade migrations in one-off containers of the new image;
#   8. switches: docker compose up -d --no-build;
#   9. checks that /sign-in answers 200, that the app runs the new commit and
#      that the assistant worker started. If not, it puts the previous image
#      back.
#
# Any failure up to step 7 exits non-zero with the old app still serving and
# agentsdr:local pointing at the old image again. Migrations are additive:
# the ones that ran stay applied, and the old image runs on them.
#
# Compose files: COMPOSE_FILE (from the environment or .env) is used as it
# is. Otherwise the script uses docker-compose.yml, docker-compose.build.yml
# and docker-compose.discovery.yml. Leaving out the discovery file (the Maps
# scraper) needs --yes or DISCOVERY_OPTIONAL=1.
#
# Settings (environment):
#   BRANCH                     branch to deploy (claude/dreamy-fermi-h5woha; --branch wins)
#   SKIP_GIT_UPDATE=1          deploy the checkout as it is
#   MIN_BUILD_MEM_MB           MemAvailable + SwapFree the build needs (7168)
#   NEXT_BUILD_HEAP_MB         heap limit of each Node process in the build (4096,
#                              the Dockerfile's; 3072 runs a build worker out of heap)
#
# Measured on 19 October (ab84f96, Node 22, the Dockerfile's build step): with
# a 4096 MB heap the build takes about 6.0 GB (its largest worker 5.9 GB);
# with 3072 MB a webpack worker runs out of heap and the build fails.
#   HEALTH_URL                 http://127.0.0.1:<PORT from .env, or 3000>/sign-in; a
#                              PORT holding an address ("127.0.0.1:3000", the form
#                              compose's ports accept) gives that host and port
#   HEALTH_TIMEOUT_S           how long the new app gets to answer 200 (180)
#   WORKER_LOG_TIMEOUT_S       how long to wait for the worker's start line (60)
#   MIGRATIONS                 scripts/<name>.ts to run, in order (this release's
#                              nine; set it empty to run none)
#   BACKUP_DIR                 dumps and saved edits (./deploy-backups, which
#                              .dockerignore keeps out of the image build)
#   EXTERNAL_DB_BACKUP_DONE=1  needed when the database is not the bundled `db`
#                              service: back it up yourself first
#   MEMINFO_FILE               read instead of /proc/meminfo (tests)

set -euo pipefail

readonly IMAGE=agentsdr:local
readonly WORKER_READY='[assistant/worker] starting'
readonly DEFAULT_MIGRATIONS="add-tinyfish add-research-sources add-browser-sessions add-wrong-number add-activity add-assistant-job-reports add-objectives add-pilot-fixes add-brightdata add-always-on-sending add-research-agent-v2 add-managed-saas add-sender-pacing add-whatsapp-warmup-off"

SCRIPT_PATH=$(realpath "${BASH_SOURCE[0]}")
ORIGINAL_ARGS=("$@")
TS=$(date -u +%Y%m%d-%H%M%S)

BRANCH=${BRANCH:-claude/dreamy-fermi-h5woha}
ASSUME_YES=0
PHASE=preflight # preflight -> built -> switched -> rolled-back | finished
REV=""
ROLLBACK_TAG=""
BACKUP_FILE=""
PATCH_FILE=""
NEW_IMAGE_ID=""
SCRAPER_STOPPED=0
HAS_DISCOVERY=1
HAS_BUNDLED_DB=1
COMPOSE_ARGS=()
COMPOSE_FILES=()
COMPOSE_CMD="docker compose"

log() { printf '%s deploy: %s\n' "$(date -u +%H:%M:%S)" "$*"; }
step() { printf '\n'; log "== $*"; }
warn() { printf '%s deploy: WARNING: %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
die() {
  printf '%s deploy: FAILED: %s\n' "$(date -u +%H:%M:%S)" "$*" >&2
  exit 1
}

usage() {
  awk 'NR > 1 && !/^#/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "$SCRIPT_PATH"
}

compose() { docker compose ${COMPOSE_ARGS[@]+"${COMPOSE_ARGS[@]}"} "$@"; }

# True when the newline-separated $1 has the line $2.
has_line() { [[ $'\n'$1$'\n' == *$'\n'$2$'\n'* ]]; }

# NAME's value in ./.env (the last assignment wins), without quotes.
dotenv_value() {
  local name=$1 line value=""
  [[ -f .env ]] || return 0
  while IFS= read -r line || [[ -n $line ]]; do
    line=${line%$'\r'}
    if [[ $line =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ && ${BASH_REMATCH[2]} == "$name" ]]; then
      value=${BASH_REMATCH[3]}
    fi
  done <.env
  value=${value#"${value%%[![:space:]]*}"}
  case $value in
    \"*\" | \'*\') value=${value:1:${#value}-2} ;;
    *)
      value=${value%%[[:space:]]#*}
      value=${value%"${value##*[![:space:]]}"}
      ;;
  esac
  printf '%s' "$value"
}

parse_args() {
  if [[ ${DISCOVERY_OPTIONAL:-} == 1 ]]; then ASSUME_YES=1; fi
  while (($#)); do
    case $1 in
      --branch)
        (($# >= 2)) || die "--branch needs a branch name"
        BRANCH=$2
        shift 2
        ;;
      --branch=*) BRANCH=${1#*=} && shift ;;
      -y | --yes) ASSUME_YES=1 && shift ;;
      -h | --help) usage && exit 0 ;;
      *)
        usage >&2
        exit 2
        ;;
    esac
  done
}

# The sign-in page's URL from a compose-style PORT: "3000", "127.0.0.1:3000",
# "0.0.0.0:3000" or "[::1]:3000". A wildcard host is reached on loopback, and
# an IPv6 host keeps (or gets) its brackets.
health_url_for() {
  local value=$1 host=127.0.0.1 port=$1
  if [[ $value == *:* ]]; then
    host=${value%:*}
    port=${value##*:}
    case $host in
      "" | 0.0.0.0 | "[::]" | "::") host=127.0.0.1 ;;
      \[*\]) ;;
      *:*) host="[$host]" ;;
    esac
  fi
  [[ $port =~ ^[0-9]+$ ]] || die "PORT '$value' does not end in a port number; set HEALTH_URL"
  printf 'http://%s:%s/sign-in\n' "$host" "$port"
}

load_settings() {
  MIGRATIONS=${MIGRATIONS-$DEFAULT_MIGRATIONS}
  MIN_BUILD_MEM_MB=${MIN_BUILD_MEM_MB:-7168}
  NEXT_BUILD_HEAP_MB=${NEXT_BUILD_HEAP_MB:-4096}
  HEALTH_TIMEOUT_S=${HEALTH_TIMEOUT_S:-180}
  WORKER_LOG_TIMEOUT_S=${WORKER_LOG_TIMEOUT_S:-60}
  HEALTH_INTERVAL_S=${HEALTH_INTERVAL_S:-3}
  BACKUP_DIR=$(realpath -m "${BACKUP_DIR:-deploy-backups}")
  if [[ -z ${HEALTH_URL:-} ]]; then
    local port=${PORT:-}
    [[ -n $port ]] || port=$(dotenv_value PORT)
    HEALTH_URL=$(health_url_for "${port:-3000}") || exit 1
  fi

  local knob m
  for knob in MIN_BUILD_MEM_MB NEXT_BUILD_HEAP_MB HEALTH_TIMEOUT_S WORKER_LOG_TIMEOUT_S; do
    [[ ${!knob} =~ ^[0-9]+$ ]] || die "$knob must be a whole number, not '${!knob}'"
  done
  [[ $HEALTH_INTERVAL_S =~ ^[0-9]+([.][0-9]+)?$ ]] || die "HEALTH_INTERVAL_S must be a number of seconds"
  for m in $MIGRATIONS; do
    [[ $m =~ ^[A-Za-z0-9._-]+$ ]] || die "MIGRATIONS: '$m' is not a script name under scripts/"
  done
  # Anything else inside the checkout would be sent into the image build.
  case $BACKUP_DIR/ in
    "$PWD"/deploy-backups/) ;;
    "$PWD"/*) die "BACKUP_DIR inside the checkout must be ./deploy-backups, the only one .dockerignore keeps out of the image build" ;;
  esac
}

check_compose_version() {
  local version major minor
  version=$(docker compose version --short 2>/dev/null) ||
    die "docker compose (the Compose v2 plugin) is not available; install docker-compose-plugin"
  version=${version#v}
  IFS=. read -r major minor _ <<<"$version"
  minor=${minor%%[!0-9]*}
  [[ $major =~ ^[0-9]+$ && $minor =~ ^[0-9]+$ ]] || die "cannot read the docker compose version from '$version'"
  if ((major < 2 || (major == 2 && minor < 24))); then
    die "docker compose $version is older than 2.24, which docker-compose.external-db.yml needs (!reset); upgrade docker-compose-plugin"
  fi
  log "docker compose $version"
}

uses_compose_file() {
  local file
  for file in "${COMPOSE_FILES[@]}"; do
    if [[ ${file##*/} == "$1" ]]; then return 0; fi
  done
  return 1
}

# Explicit -f flags would override a COMPOSE_FILE in .env, so a COMPOSE_FILE
# is honoured by passing no -f at all.
resolve_compose_files() {
  local value origin separator file
  separator=${COMPOSE_PATH_SEPARATOR:-}
  [[ -n $separator ]] || separator=$(dotenv_value COMPOSE_PATH_SEPARATOR)
  if [[ -n ${COMPOSE_FILE:-} ]]; then
    value=$COMPOSE_FILE
    origin="COMPOSE_FILE from the environment"
  else
    value=$(dotenv_value COMPOSE_FILE)
    origin="COMPOSE_FILE from .env"
  fi
  if [[ -n $value ]]; then
    IFS=${separator:-:} read -r -a COMPOSE_FILES <<<"$value"
  else
    COMPOSE_FILES=(docker-compose.yml docker-compose.build.yml docker-compose.discovery.yml)
    for file in "${COMPOSE_FILES[@]}"; do COMPOSE_ARGS+=(-f "$file"); done
    COMPOSE_CMD="docker compose ${COMPOSE_ARGS[*]}"
    origin="default"
  fi
  log "compose files ($origin): ${COMPOSE_FILES[*]}"

  uses_compose_file docker-compose.build.yml ||
    die "docker-compose.build.yml is not among the compose files, so the app image would come from the registry instead of this checkout; add it to COMPOSE_FILE"
  if ! uses_compose_file docker-compose.discovery.yml; then
    HAS_DISCOVERY=0
    warn "docker-compose.discovery.yml is not among the compose files: the Maps scraper will not be configured (no GMAPS_SCRAPER_URL), and the assistant cannot search Google Maps"
    ((ASSUME_YES)) ||
      die "add docker-compose.discovery.yml to COMPOSE_FILE, or pass --yes (or DISCOVERY_OPTIONAL=1) to deploy without the Maps scraper"
  fi
}

check_memory() {
  local file=${MEMINFO_FILE:-/proc/meminfo} available
  [[ -r $file ]] || die "cannot read $file"
  available=$(awk '/^MemAvailable:/ { a = $2 } /^SwapFree:/ { s = $2 } END { printf "%d", (a + s) / 1024 }' "$file")
  log "memory for the build: ${available} MB (MemAvailable + SwapFree, Maps scraper still running); need ${MIN_BUILD_MEM_MB} MB"
  if ((available < MIN_BUILD_MEM_MB)); then
    cat >&2 <<EOF

The image build needs about ${MIN_BUILD_MEM_MB} MB next to the running app
(it was measured at about 6 GB); this VM has ${available} MB. A build that
runs it out of memory can take the whole VM down, SSH included. Add a 4 GB
swap file (once; it survives reboots), then run this script again:

  sudo fallocate -l 4G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

(If /swapfile already exists, pick another name. Check with: free -m)
EOF
    die "not enough memory for the image build (${available} MB < ${MIN_BUILD_MEM_MB} MB)"
  fi
}

preflight() {
  step "1/9 preflight"
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "$PWD is not a git checkout"
  [[ -f docker-compose.yml ]] || die "no docker-compose.yml in $PWD"
  check_compose_version
  docker info >/dev/null 2>&1 || die "docker info failed: is the Docker daemon running, and may $(id -un) use it?"
  resolve_compose_files
  compose config --quiet || die "docker compose cannot read these compose files (see above)"
  local services
  services=$(compose config --services)
  if ! has_line "$services" db; then
    HAS_BUNDLED_DB=0
    [[ ${EXTERNAL_DB_BACKUP_DONE:-} == 1 ]] ||
      die "the database is not the bundled db service (external database), so this script cannot back it up. Dump it yourself (pg_dump --format=custom), then re-run with EXTERNAL_DB_BACKUP_DONE=1"
  fi
  check_memory
}

prepare_backup_dir() {
  if [[ ! -d $BACKUP_DIR ]]; then
    mkdir -p "$BACKUP_DIR"
    chmod 700 "$BACKUP_DIR"
  fi
  # Keeps the dumps and saved edits out of `git status`.
  [[ -e $BACKUP_DIR/.gitignore ]] || printf '*\n' >"$BACKUP_DIR/.gitignore"
  log "backups go to $BACKUP_DIR"
}

save_local_edits() {
  PATCH_FILE="$BACKUP_DIR/vm-local-$TS.patch"
  git diff --binary HEAD >"$PATCH_FILE"
  git status --porcelain >"$BACKUP_DIR/vm-local-$TS.status"
  if [[ -s $PATCH_FILE ]]; then
    log "local edits saved to $PATCH_FILE (re-apply with: git apply --3way $PATCH_FILE)"
  else
    log "no local edits to tracked files"
  fi
}

explain_refused_update() {
  local target="origin/$BRANCH" ahead overlap
  ahead=$(git rev-list --count "$target..HEAD" 2>/dev/null) || ahead=0
  if [[ $ahead != 0 ]]; then
    warn "$BRANCH has $ahead commit(s) that $target does not (commits made on this VM):"
    git log --oneline "$target..HEAD" >&2 || true
  fi
  overlap=$(comm -12 <(git diff --name-only HEAD "$target" 2>/dev/null | sort) \
    <(git status --porcelain 2>/dev/null | cut -c4- | sort)) || overlap=""
  if [[ -n $overlap ]]; then
    warn "files edited on this VM that the update also changes:"
    printf '  %s\n' "${overlap//$'\n'/$'\n'  }" >&2
    warn "to take the update: undo those edits (git checkout -- <file>), re-run, then re-apply what is still needed from the saved patch"
  fi
}

update_checkout() {
  step "2/9 update the checkout"
  if [[ ${SKIP_GIT_UPDATE:-} == 1 ]]; then
    log "SKIP_GIT_UPDATE=1: deploying the checkout as it is"
    git diff --quiet HEAD || warn "tracked files have local edits; they are built into the image"
    return 0
  fi
  save_local_edits
  local current script_before script_after
  script_before=$(git rev-parse -q --verify HEAD:docker/deploy.sh) || script_before=""
  # An explicit refspec: a single-branch clone would otherwise leave
  # origin/$BRANCH stale, and the merge below would deploy old code.
  git fetch origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH" ||
    die "git fetch of $BRANCH from origin failed; nothing was changed"
  current=$(git symbolic-ref --short -q HEAD) || current=""
  if [[ $current != "$BRANCH" ]]; then
    git diff --quiet HEAD ||
      die "the checkout is on '${current:-a detached HEAD}', not $BRANCH, and has edits to tracked files (saved in $PATCH_FILE). Commit or undo them there, then re-run"
    log "checking out $BRANCH (was '${current:-a detached HEAD}')"
    git checkout "$BRANCH" || die "git checkout $BRANCH failed; nothing else was changed"
  fi
  log "fast-forwarding $BRANCH to origin/$BRANCH"
  if ! git merge --ff-only "origin/$BRANCH"; then
    explain_refused_update
    die "git refused to fast-forward $BRANCH; nothing was changed. Your edits are saved in $PATCH_FILE"
  fi
  if [[ $(git rev-parse HEAD) != "$(git rev-parse "origin/$BRANCH")" ]]; then
    warn "$BRANCH has commits that origin/$BRANCH does not; they are deployed too"
  fi
  script_after=$(git rev-parse -q --verify HEAD:docker/deploy.sh) || script_after=""
  if [[ $script_after != "$script_before" && ${DEPLOY_REEXEC:-} != 1 ]]; then
    log "docker/deploy.sh changed in this update; continuing with the new version"
    exec env SKIP_GIT_UPDATE=1 DEPLOY_REEXEC=1 BRANCH="$BRANCH" bash "$SCRIPT_PATH" ${ORIGINAL_ARGS[@]+"${ORIGINAL_ARGS[@]}"}
  fi
}

backup_database() {
  step "3/9 database backup"
  if ((!HAS_BUNDLED_DB)); then
    warn "external database: relying on your own backup (EXTERNAL_DB_BACKUP_DONE=1)"
    return 0
  fi
  local dump="$BACKUP_DIR/agentsdr-$TS.dump"
  log "pg_dump to $dump"
  if ! compose exec -T db pg_dump -U agentsdr --format=custom agentsdr >"$dump"; then
    rm -f "$dump"
    die "pg_dump failed; nothing was changed"
  fi
  if [[ ! -s $dump ]]; then
    rm -f "$dump"
    die "pg_dump wrote an empty file; nothing was changed"
  fi
  if ! compose exec -T db pg_restore --list <"$dump" >/dev/null; then
    rm -f "$dump"
    die "the dump does not read back (pg_restore --list failed); nothing was changed"
  fi
  chmod 600 "$dump"
  BACKUP_FILE=$dump
  log "backup ok: $dump ($(du -h "$dump" | cut -f1))"
}

app_container_id() {
  local ids
  ids=$(compose ps -q app 2>/dev/null) || ids=""
  printf '%s' "${ids%%$'\n'*}"
}

image_revision() {
  docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$1"
}

# The running container's image, rather than agentsdr:local: after a run
# that built but did not switch, the tag may name an image that never ran.
tag_rollback_image() {
  step "4/9 rollback image"
  local cid from=""
  cid=$(app_container_id)
  if [[ -n $cid ]]; then
    from=$(docker inspect --format '{{.Image}}' "$cid")
  elif docker image inspect "$IMAGE" >/dev/null 2>&1; then
    from=$IMAGE
  fi
  if [[ -z $from ]]; then
    warn "no app container and no $IMAGE image: there is nothing to roll back to"
    return 0
  fi
  ROLLBACK_TAG="agentsdr:rollback-$TS"
  docker tag "$from" "$ROLLBACK_TAG"
  log "previous image $from tagged $ROLLBACK_TAG"
}

pause_scraper() {
  step "5/9 Maps scraper"
  if ((!HAS_DISCOVERY)); then
    log "not configured; nothing to stop"
    return 0
  fi
  local running
  running=$(compose ps --status running --services 2>/dev/null) || running=""
  if ! has_line "$running" gmaps-scraper; then
    log "gmaps-scraper is not running; nothing to stop"
    return 0
  fi
  log "stopping gmaps-scraper during the build (frees up to 1.5 GB); it starts again whatever happens"
  SCRAPER_STOPPED=1
  compose stop gmaps-scraper
}

build_image() {
  step "6/9 build $IMAGE"
  log "building $REV with NEXT_BUILD_HEAP_MB=$NEXT_BUILD_HEAP_MB; the running app keeps serving"
  if ! compose build --build-arg GIT_SHA="$REV" --build-arg NEXT_BUILD_HEAP_MB="$NEXT_BUILD_HEAP_MB" app; then
    die "the image build failed; the running app is untouched. If Node ran out of heap, raise NEXT_BUILD_HEAP_MB; if the VM ran short of memory, add swap"
  fi
  PHASE=built
  local built
  built=$(image_revision "$IMAGE") || built=""
  [[ $built == "$REV" ]] ||
    die "$IMAGE is labelled '${built:-nothing}', not $REV: these compose files do not build the app as $IMAGE from this checkout"
  log "built $IMAGE at $REV"
}

run_migrations() {
  step "7/9 migrations"
  local m applied=()
  for m in $MIGRATIONS; do
    log "migration $m"
    if ! compose run --rm --no-deps -T app bun "scripts/$m.ts"; then
      die "migration $m failed; nothing was switched and the old app keeps serving. Applied before it: ${applied[*]:-none} (additive: the old app runs on them). Fix the cause and re-run; every migration is re-runnable"
    fi
    applied+=("$m")
  done
  if ((${#applied[@]} == 0)); then log "no migrations to run (MIGRATIONS is empty)"; fi
}

switch_app() {
  step "8/9 switch"
  PHASE=switched
  log "docker compose up -d --no-build"
  compose up -d --no-build || rollback "docker compose up -d failed"
  SCRAPER_STOPPED=0 # up -d started every service, the scraper included
}

wait_for_health() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT_S)) code
  log "waiting for $HEALTH_URL to answer 200 (up to ${HEALTH_TIMEOUT_S}s)"
  while :; do
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$HEALTH_URL" 2>/dev/null) || true
    if [[ $code == 200 ]]; then
      log "$HEALTH_URL answered 200"
      return 0
    fi
    if ((SECONDS >= deadline)); then
      warn "$HEALTH_URL last answered '${code:-nothing}'"
      return 1
    fi
    sleep "$HEALTH_INTERVAL_S"
  done
}

check_revision() {
  local cid image revision
  cid=$(app_container_id)
  if [[ -z $cid ]]; then
    warn "no app container is running"
    return 1
  fi
  image=$(docker inspect --format '{{.Image}}' "$cid") || return 1
  revision=$(image_revision "$image") || return 1
  if [[ $revision != "$REV" ]]; then
    warn "the app container runs revision '${revision:-unknown}', not $REV"
    return 1
  fi
  NEW_IMAGE_ID=$image
  log "the app container runs $image (revision $revision)"
}

# Logs since the container's own start: a redeploy of an unchanged image does
# not recreate the container, and its start line predates the switch.
wait_for_worker() {
  local cid started logs deadline=$((SECONDS + WORKER_LOG_TIMEOUT_S))
  cid=$(app_container_id)
  [[ -n $cid ]] || return 1
  started=$(docker inspect --format '{{.State.StartedAt}}' "$cid") || return 1
  log "waiting for '$WORKER_READY' in the app log (up to ${WORKER_LOG_TIMEOUT_S}s)"
  while :; do
    logs=$(compose logs --no-color --since "$started" app 2>&1) || logs=""
    if [[ $logs == *"$WORKER_READY"* ]]; then
      log "the assistant worker started"
      return 0
    fi
    if ((SECONDS >= deadline)); then return 1; fi
    sleep "$HEALTH_INTERVAL_S"
  done
}

verify_app() {
  step "9/9 checks"
  wait_for_health || rollback "$HEALTH_URL did not answer 200 within ${HEALTH_TIMEOUT_S}s"
  check_revision || rollback "the app container does not run revision $REV"
  wait_for_worker || rollback "the app log shows no '$WORKER_READY' within ${WORKER_LOG_TIMEOUT_S}s"
}

rollback() {
  PHASE=rolled-back
  warn "check failed after the switch: $1"
  if [[ -z $ROLLBACK_TAG ]]; then
    die "there is no previous image to roll back to; the new one stays. Look at: $COMPOSE_CMD logs app"
  fi
  log "rolling back: $ROLLBACK_TAG -> $IMAGE, then up -d --no-build app"
  if docker tag "$ROLLBACK_TAG" "$IMAGE" && compose up -d --no-build app; then
    if wait_for_health; then
      log "the previous image is serving again"
    else
      warn "the previous image does not answer 200 either; look at: $COMPOSE_CMD logs app"
    fi
  else
    warn "the rollback failed; run it by hand: docker tag $ROLLBACK_TAG $IMAGE && $COMPOSE_CMD up -d --no-build app"
  fi
  warn "the migrations stay applied: they are additive, and the previous image runs on them"
  die "deploy of $REV rolled back (database backup: ${BACKUP_FILE:-none})"
}

# shellcheck disable=SC2329 # run by `trap on_exit EXIT`
on_exit() {
  local status=$?
  trap - EXIT
  # Built but never switched: point the tag back at the image that runs, so
  # a later plain `docker compose up -d` cannot start unmigrated code.
  if ((status != 0)) && [[ $PHASE == built && -n $ROLLBACK_TAG ]]; then
    if docker tag "$ROLLBACK_TAG" "$IMAGE"; then
      log "$IMAGE points at the running image again ($ROLLBACK_TAG)"
    else
      warn "could not tag $ROLLBACK_TAG as $IMAGE; do it before any docker compose up"
    fi
  fi
  if ((SCRAPER_STOPPED)); then
    log "starting gmaps-scraper again"
    compose start gmaps-scraper || warn "could not start gmaps-scraper; run: $COMPOSE_CMD start gmaps-scraper"
  fi
  exit "$status"
}

summary() {
  PHASE=finished
  printf '\n'
  log "deployed $REV"
  cat <<EOF
  image            ${NEW_IMAGE_ID} ($IMAGE)
  database backup  ${BACKUP_FILE:-none (external database)}
  VM edits saved   ${PATCH_FILE:-not saved (SKIP_GIT_UPDATE=1)}
  previous image   ${ROLLBACK_TAG:-none}

Check the running image:
  $COMPOSE_CMD ps
  docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' \$($COMPOSE_CMD ps -q app)
  $COMPOSE_CMD exec app ls scripts/add-pilot-fixes.ts
  $COMPOSE_CMD logs --since 15m app | grep -F '$WORKER_READY'
EOF
  if ((HAS_BUNDLED_DB)); then
    cat <<EOF
  $COMPOSE_CMD exec db psql -U agentsdr agentsdr -Atc "select to_regclass('tinyfish_settings'), to_regclass('research_settings'), to_regclass('browser_sessions'), to_regclass('crm_wrong_routes'), to_regclass('activity_seen'), to_regclass('assistant_objectives'), to_regclass('brightdata_settings')"
  $COMPOSE_CMD exec db psql -U agentsdr agentsdr -Atc "select count(*) from information_schema.columns where (table_name, column_name) in (('lead_audience_members','fit'), ('lead_audience_members','fit_claimed_at'), ('whatsapp_accounts','last_refusal'))"
EOF
  fi
  if [[ -n $ROLLBACK_TAG ]]; then
    cat <<EOF

Roll back by hand (the migrations can stay):
  docker tag $ROLLBACK_TAG $IMAGE && $COMPOSE_CMD up -d --no-build app
Rollback images keep their layers on disk; list them with: docker image ls agentsdr
EOF
  fi
}

main() {
  parse_args "$@"
  cd "$(dirname "$SCRIPT_PATH")/.."
  load_settings
  trap on_exit EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  log "deploying $BRANCH from $PWD"

  preflight
  prepare_backup_dir
  update_checkout
  REV=$(git rev-parse HEAD)
  log "revision $REV"
  backup_database
  tag_rollback_image
  pause_scraper
  build_image
  run_migrations
  switch_app
  verify_app
  summary
}

# On one line: bash has read it all before `git merge` can rewrite this file.
main "$@"; exit
