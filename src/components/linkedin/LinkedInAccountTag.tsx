"use client";

import { useState } from "react";

export type LinkedInAccountRef = {
  username: string;
  name: string | null;
  profilePictureUrl: string | null;
};

const SIZE = {
  sm: {
    pill: "pl-0.5 pr-2 py-0.5 gap-1",
    avatar: "h-5 w-5 text-[11px]",
    text: "text-xs max-w-28",
  },
  md: {
    pill: "pl-1 pr-2.5 py-1 gap-1.5",
    avatar: "h-6 w-6 text-[12px]",
    text: "text-sm max-w-36",
  },
} as const;

function TagAvatar({ account, avatarClass }: { account: LinkedInAccountRef; avatarClass: string }) {
  const [err, setErr] = useState(false);
  const display = account.name ?? account.username;
  const initials = display
    .split(/[\s/]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");

  if (account.profilePictureUrl && !err) {
    return (
      <img
        src={account.profilePictureUrl}
        alt=""
        className={`${avatarClass} rounded-full object-cover bg-bg-weak-50 shrink-0`}
        onError={() => setErr(true)}
      />
    );
  }

  return (
    <span
      className={`${avatarClass} rounded-full bg-primary-alpha-10 text-primary-base flex items-center justify-center font-semibold shrink-0`}
    >
      {initials || "?"}
    </span>
  );
}

export function LinkedInAccountTag({
  account,
  size = "sm",
  className = "",
}: {
  account: LinkedInAccountRef;
  size?: keyof typeof SIZE;
  className?: string;
}) {
  const styles = SIZE[size];
  const displayName = account.name ?? account.username;
  const tooltip = account.name ? `${account.name} (@${account.username})` : `@${account.username}`;

  return (
    <span
      className={`inline-flex items-center rounded-full border border-stroke-soft-200 bg-bg-white-0 shadow-regular-xs ${styles.pill} max-w-full ${className}`}
      title={tooltip}
    >
      <TagAvatar account={account} avatarClass={styles.avatar} />
      <span className={`font-medium text-text-sub-600 truncate ${styles.text}`}>{displayName}</span>
    </span>
  );
}

export function LinkedInAccountTags({
  accounts,
  size = "sm",
  maxVisible = 2,
}: {
  accounts: (LinkedInAccountRef & { id?: string })[];
  size?: keyof typeof SIZE;
  maxVisible?: number;
}) {
  if (accounts.length === 0) {
    return <span className="text-xs text-text-soft-400">—</span>;
  }

  const visible = accounts.slice(0, maxVisible);
  const extra = accounts.length - visible.length;

  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {visible.map((account, i) => (
        <LinkedInAccountTag key={account.id ?? `${account.username}-${i}`} account={account} size={size} />
      ))}
      {extra > 0 && <span className="text-xs font-medium text-text-soft-400">+{extra}</span>}
    </span>
  );
}

/**
 * Avatar-only variant for places where the senders are context rather than the
 * subject — the faces identify the accounts, and the names are one hover away.
 */
export function LinkedInAccountAvatars({
  accounts,
  maxVisible = 4,
}: {
  accounts: (LinkedInAccountRef & { id?: string })[];
  maxVisible?: number;
}) {
  if (accounts.length === 0) return <span className="text-paragraph-xs text-text-soft-400">No senders</span>;

  const visible = accounts.slice(0, maxVisible);
  const extra = accounts.length - visible.length;

  return (
    <span className="inline-flex items-center">
      {visible.map((account, i) => {
        const display = account.name ?? account.username;
        return (
          <span
            key={account.id ?? `${account.username}-${i}`}
            title={account.name ? `${account.name} (@${account.username})` : `@${account.username}`}
            className="-ml-1.5 rounded-full ring-2 ring-bg-white-0 first:ml-0"
          >
            <TagAvatar account={account} avatarClass="h-6 w-6 text-[12px]" />
            <span className="sr-only">{display}</span>
          </span>
        );
      })}
      {extra > 0 && (
        <span
          title={accounts.slice(maxVisible).map((account) => account.name ?? account.username).join(", ")}
          className="-ml-1.5 flex h-6 items-center rounded-full bg-bg-weak-50 px-1.5 text-[12px] font-medium text-text-sub-600 ring-2 ring-bg-white-0"
        >
          +{extra}
        </span>
      )}
    </span>
  );
}
