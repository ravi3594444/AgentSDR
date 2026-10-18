# Graph Report - AgentSDR  (2026-10-18)

## Corpus Check
- 1672 files · ~1,894,417 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 18 file(s) not represented in the graph (top: (none) 10, .css 3, .example 1)

## Summary
- 10036 nodes · 36628 edges · 217 communities (202 shown, 15 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 230 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `de2d8f8c`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- tenancy/scope.ts
- runInOrganization
- sequences.ts
- ref_remixicon_react
- CrmActionsClient.tsx
- MessagesLayout.tsx
- Frame
- WorkbookListClient.tsx
- withOrgContext
- CampaignClient.tsx
- cn
- Skeleton
- grid/columns.ts
- demo/email.ts
- alignui/badge.tsx
- crm/schema.ts
- GridClient.tsx
- WhatsappCampaignsClient.tsx
- calls/contract.ts
- grid/worker.ts
- assistant/agent.server.ts
- crm.ts
- webDiscovery.server.ts
- instagram/messages.ts
- autopilotRun.server.ts
- ref_fs
- decisions.server.ts
- handlers.ts
- ref_pg
- conversations.ts
- http.server.ts
- fields.ts
- background.ts
- runners/types.ts
- treg.server.ts
- workspace.ts
- campaigns.server.ts
- discovery.server.ts
- integrations/catalog.ts
- endpoints.server.ts
- requirePermission
- ref_react
- requirePageOrgContext
- websiteContacts.server.ts
- ref_bun
- geocode.server.ts
- unipile.instagram.ts
- calls/campaigns.ts
- grid/schema.ts
- sessions.ts
- leads/columns.ts
- whatsapp/messages.ts
- wa-agent.ts
- grid/types.ts
- navConfig.ts
- assistant/outreach.server.ts
- classify-legacy-raw-conflicts.ts
- ResultsClient.tsx
- whatsapp/send.ts
- ref_node_fs
- core.ts
- runSearchQueue.ts
- assistant/schema.ts
- tables.ts
- CompanyResearchModal.tsx
- dailyRollover.ts
- crm/http.ts
- whatsapp.ts
- SignInForm.tsx
- searchBatches.ts
- inOrg
- read.ts
- CrmConfigurationValidationError
- overview.ts
- CrmAiInstructions.tsx
- webSearch.server.ts
- apify.server.ts
- rules.ts
- categories.ts
- outreach/schema.ts
- mode.ts
- results.server.ts
- LiquidEngine
- unipileMail.ts
- wa-hook.ts
- import.ts
- ref_node_assert
- sendFollowUps.ts
- readiness.ts
- auth/server.ts
- organizations.server.ts
- assistant.ts
- quota.server.ts
- PermanentRunError
- draft.ts
- leadStage.ts
- whatsapp/parse.ts
- currentOrganizationId
- linkedin.ts
- flags.server.ts
- importMapping.ts
- ref_server_only
- diagnose-instagram-delivery.ts
- knowledge-service.ts
- engine.ts
- transcription.ts
- services/tinyfish.ts
- tenancy/registry.ts
- linkedin.server.ts
- grounding.ts
- test-integrations-live.ts
- platform/credentials.ts
- app/layout.tsx
- jobRunner.ts
- providers.ts
- InquiriesSettings.tsx
- AssistantClient.tsx
- CampaignLeadsTab.tsx
- instagram.ts
- Sidebar.tsx
- mapping.ts
- outreach/render.ts
- web-discovery.ts
- ChannelSettingsPages.tsx
- LeadDetailPanel.tsx
- manifest.json
- crm/send.ts
- [tableId]/export/route.ts
- tools.server.ts
- outreachHistory.ts
- tinyfish.server.ts
- analytics/contract.ts
- contacts.ts
- tenancy-isolation.ts
- test-people-crm-core.ts
- auth/schema.ts
- LinkedInAccountTag
- src/messages.ts
- repository.ts
- ai/server/types.ts
- whatsapp/accounts.ts
- ChannelRulesForm.tsx
- linkedin/LeadsClient.tsx
- platform/catalog.ts
- migrationParity.ts
- ConnectionSettingsPage
- campaigns/CampaignDetailClient.tsx
- results.ts
- e2e/tinyfish.ts
- instagram/parse.ts
- unsubscribeToken.ts
- audit-email-people-parity.ts
- guardedSearch
- qualification/campaigns.ts
- whatsapp.server.ts
- tinyfish/route.ts
- ref_bun_test
- cn
- e2e/apify.ts
- qualification/index.ts
- mailDomain.server.ts
- options.ts
- lib/queries.ts
- analytics/route.ts
- templates.ts
- endCall
- update.ts
- intake.ts
- leadImport.ts
- lusha/actions.ts
- apollo.ts
- ByokSettingsClient.tsx
- instagramUsername
- asRecord
- ReplyComposer.tsx
- DomainsTable.tsx
- socialAdapters.ts
- CreateCampaignForm.tsx
- apollo/actions.ts
- sendFromInbox.test.ts
- ads.ts
- audit-linkedin-message-duplicates.ts
- export-people-migration-reconciliation.ts
- mark-linkedin-message-duplicates.ts
- rotate-integration-credentials.ts
- WhatsappSequenceEditor
- rollback-people-migration.ts
- add-mailboxes.ts
- domains/page.tsx
- CategoryFilter.tsx
- Filters.tsx
- searchLeadLimit.ts
- owner-controls.ts
- finalize-lead-tables.ts
- app/campaigns/page.tsx
- add-category-columns.js
- normalize-targeted-domains.js
- precompute-category-counts.js
- unsubscribe/page.tsx
- leadsTemplate.ts
- LeadActivityPanel.tsx
- ref_next
- ActionsMenu.tsx
- Badge.tsx
- filterLeadsClient.ts
- drizzle.config.ts
- test-linkedin-webhook-inbox-fixture.sh
- linkedin/leads/loading.tsx
- LinkedInPageHeader.tsx
- StatCard.tsx
- linkedInAccountSelect.ts
- leadListSelect.ts
- { signIn, signUp, signOut, useSession, useActiveOrganization, useListOrganizations, organization }

## God Nodes (most connected - your core abstractions)
1. `inOrg()` - 673 edges
2. `cn()` - 398 edges
3. `currentOrganizationId()` - 300 edges
4. `withOrgContext()` - 289 edges
5. `db` - 237 edges
6. `runInOrganization()` - 234 edges
7. `authContextErrorResponse()` - 232 edges
8. `Frame()` - 150 edges
9. `FramePanel()` - 150 edges
10. `FrameHeader()` - 111 edges

## Surprising Connections (you probably didn't know these)
- `save()` --indirect_call--> `minutes()`  [INFERRED]
  src/components/settings/organization/TinyfishSettings.tsx → scripts/db/demo/email.ts
- `act()` --indirect_call--> `answer()`  [INFERRED]
  src/components/assistant/AssistantClient.tsx → extensions/whatsapp-recorder/src/wa-hook.ts
- `act()` --indirect_call--> `answer()`  [INFERRED]
  src/components/assistant/NeedsYouList.tsx → extensions/whatsapp-recorder/src/wa-hook.ts
- `main()` --calls--> `resolveProfiles()`  [EXTRACTED]
  scripts/resolve-legacy-linkedin-identifiers.ts → src/functions/resolveProfiles.ts
- `compareEmailParityRow()` --calls--> `personVariables()`  [EXTRACTED]
  scripts/audit-email-people-parity.ts → src/lib/leads/variables.ts

## Import Cycles
- None detected.

## Communities (217 total, 15 thin omitted)

### Community 0 - "tenancy/scope.ts"
Cohesion: 0.03
Nodes (141): dryRun, check(), runScenario(), WAIT_MS, waitFor(), stamp, Check, runAutomationChecks() (+133 more)

### Community 1 - "runInOrganization"
Cohesion: 0.12
Nodes (61): parseAddCampaignContactRequest(), POST(), parseUpdateCampaignRequest(), PATCH(), parseCreateCampaignRequest(), POST(), parseLogCallMessageRequest(), POST() (+53 more)

### Community 2 - "sequences.ts"
Cohesion: 0.05
Nodes (130): dryRun, main(), seedCrmSetup(), dryRun, main(), partA(), partB(), dryRun (+122 more)

### Community 3 - "ref_remixicon_react"
Cohesion: 0.02
Nodes (207): CallingLayout(), dynamic, metadata, dynamic, dynamic, dynamic, dynamic, dynamic (+199 more)

### Community 4 - "CrmActionsClient.tsx"
Cohesion: 0.02
Nodes (228): AnalyticsPage(), dynamic, metadata, Search, CrmActionsPage(), metadata, CrmPipelinePage(), metadata (+220 more)

### Community 5 - "MessagesLayout.tsx"
Cohesion: 0.03
Nodes (196): CallingMessagesPage(), dynamic, metadata, dynamic, InboxPage(), metadata, dynamic, metadata (+188 more)

### Community 6 - "Frame"
Cohesion: 0.04
Nodes (172): Section(), dynamic, InstagramMessagesPage(), metadata, dynamic, dynamic, metadata, Page() (+164 more)

### Community 7 - "WorkbookListClient.tsx"
Cohesion: 0.12
Nodes (22): WorkbookRow, MoveToFolderDialog(), pathOf(), CreatedWorkbook, WorkbookIcon(), folderContents(), formatDate(), plural() (+14 more)

### Community 8 - "withOrgContext"
Cohesion: 0.04
Nodes (125): GET(), GET(), POST(), POST(), GET(), DELETE(), DELETE(), GET() (+117 more)

### Community 9 - "CampaignClient.tsx"
Cohesion: 0.03
Nodes (153): CallCampaignPage(), CallCampaignsPage(), metadata, dynamic, GET(), ZIP_PATH, dynamic, dynamic (+145 more)

### Community 10 - "cn"
Cohesion: 0.03
Nodes (124): dynamic, metadata, Checkbox, IconCheck(), IconIndeterminate(), Content, Item, ItemIcon() (+116 more)

### Community 11 - "Skeleton"
Cohesion: 0.06
Nodes (52): Loading(), Loading(), Loading(), CallingMessagesLoading(), Loading(), Loading(), CrmRecordLoading(), Loading() (+44 more)

### Community 12 - "grid/columns.ts"
Cohesion: 0.07
Nodes (67): RFC-6901, resolveCell(), RUN_COLUMN_TYPES, getAiModel(), promptColumnKeys(), AiColumnInput, assertUsable(), createAiColumns() (+59 more)

### Community 13 - "demo/email.ts"
Cohesion: 0.03
Nodes (109): RFC-2822, RFC-3464, BOUNCE_LOCAL_PARTS, main(), main(), apply, main(), BOUNCE_LOCAL_PARTS (+101 more)

### Community 14 - "alignui/badge.tsx"
Cohesion: 0.03
Nodes (82): dynamic, dynamic, LeadCategoriesPage(), metadata, AVATAR_ROOT_NAME, AvatarImage, AvatarImageProps, AvatarIndicator() (+74 more)

### Community 15 - "crm/schema.ts"
Cohesion: 0.04
Nodes (73): GET(), applyCallResultToContact(), ContactCallState, contactCallStatusForCall(), contactInScope(), fresh, NOW, UNANSWERED (+65 more)

### Community 16 - "GridClient.tsx"
Cohesion: 0.03
Nodes (113): AddColumnMenu(), CellDetailsPanel(), CellDetailsSelection, CellRun, copyValue(), DetailsResponse, displayValue(), escapePointer() (+105 more)

### Community 17 - "WhatsappCampaignsClient.tsx"
Cohesion: 0.07
Nodes (60): dynamic, metadata, WhatsappCampaignPage(), dynamic, metadata, NewWhatsappCampaignPage(), dynamic, metadata (+52 more)

### Community 18 - "calls/contract.ts"
Cohesion: 0.05
Nodes (40): ReportableCall, LiveCallCandidate, selectLiveCallId(), NOW, COLOR, CALL_STATUS_LABEL, CALL_STATUS_TONE, AddCampaignContactRequest (+32 more)

### Community 19 - "grid/worker.ts"
Cohesion: 0.03
Nodes (118): PATCH(), queueDependents(), POST(), DELETE(), hasRequiredInputs(), POST(), validateEnrichmentAccounts(), CascadeColumn (+110 more)

### Community 20 - "assistant/agent.server.ts"
Cohesion: 0.05
Nodes (79): StructuredCompletionRuntime, input, Reply, actionsProblem(), actsOnOutreach(), AgentAction, AgentReply, agentReplySchema() (+71 more)

### Community 21 - "crm.ts"
Cohesion: 0.05
Nodes (65): AFTERNOON, atWork(), awaitingDraft(), backdateConfiguration(), buildPlans(), businessTime(), cap(), Chan (+57 more)

### Community 22 - "webDiscovery.server.ts"
Cohesion: 0.05
Nodes (73): emailMatchesDomain(), placeEvidence(), rankEmails(), instagramTarget, addCandidate(), Candidate, candidateKey(), ContactAfter (+65 more)

### Community 23 - "instagram/messages.ts"
Cohesion: 0.07
Nodes (60): featureEnabled(), findInstagramAccountByUnipileId(), markInstagramAccountUnusable(), InstagramAttachment, InstagramChatSource, InstagramDirection, InstagramMessageOrigin, deliverInstagramFromCrm() (+52 more)

### Community 24 - "autopilotRun.server.ts"
Cohesion: 0.03
Nodes (138): dynamic, GET(), alreadyRewritten(), AutopilotDependencies, AutopilotOutcome, handOff(), loadState(), recordHold() (+130 more)

### Community 25 - "ref_fs"
Cohesion: 0.02
Nodes (63): { Client }, envContent, envPath, fs, path, { Client }, COUNTRIES, envContent (+55 more)

### Community 26 - "decisions.server.ts"
Cohesion: 0.08
Nodes (25): AgentModel, CrmJob, CrmSendAdapter, deps, prompts, script, Scripted, sends (+17 more)

### Community 27 - "handlers.ts"
Cohesion: 0.06
Nodes (57): dryRun, main(), CallTranscript, formatAiInstructions(), ClassificationMessage, enqueueAutopilotInTransaction(), handleAutoSendJob(), inquiryRunCoversConversation() (+49 more)

### Community 28 - "ref_pg"
Cohesion: 0.03
Nodes (17): STATEMENTS, DEFAULT_STAGE_RANKS, WIDENED, TABLES, FINAL_INDEXES, PREPARED_INDEXES, REQUIRED_COLUMNS, CORE_COLUMNS (+9 more)

### Community 29 - "conversations.ts"
Cohesion: 0.04
Nodes (76): ChannelTotals, main(), CrmConversation, CrmConversationMessage, ingestInboundReplyInTransaction(), IngestInboundReplyResult, InsertConversationMessageInput, insertConversationMessageInTransaction() (+68 more)

### Community 30 - "http.server.ts"
Cohesion: 0.07
Nodes (68): attachmentSummary(), dynamic, POST(), dynamic, GET(), Ctx, dynamic, POST() (+60 more)

### Community 31 - "fields.ts"
Cohesion: 0.12
Nodes (35): cleanString(), cleanFieldMap(), DroppedValue, fieldsFromJson(), fieldsFromPairs(), FieldTier, FlatField, FORM_CONTAINERS (+27 more)

### Community 32 - "background.ts"
Cohesion: 0.12
Nodes (36): activeCallWrites, awaitingReturn, callForTab(), clearActiveCall(), endCall(), finishActiveCall(), focusApp(), focusTab() (+28 more)

### Community 33 - "runners/types.ts"
Cohesion: 0.11
Nodes (40): EnrichmentSession, RunContext, RunSession, CellResult, EnrichmentConfig, PendingCellResult, APOLLO_HANDLERS, CONTACTOUT_HANDLERS (+32 more)

### Community 34 - "treg.server.ts"
Cohesion: 0.07
Nodes (48): Call, CATALOG, stamp, treg, failure(), GET(), PUT(), callCeilingUsd() (+40 more)

### Community 35 - "workspace.ts"
Cohesion: 0.05
Nodes (48): addMs(), Account, ANGLE_BY_INDUSTRY, apolloDebug(), apolloTrace(), BADGES, buildStores(), CampaignPlan (+40 more)

### Community 36 - "campaigns.server.ts"
Cohesion: 0.06
Nodes (66): DEFAULT_FIELDS, Unit, save(), CompanyVariableSource, PersonVariableSource, addPeopleToWhatsappCampaign(), assertUuidShape(), campaignLeadInOrg() (+58 more)

### Community 37 - "discovery.server.ts"
Cohesion: 0.08
Nodes (49): InstagramPost, NewMember, apifyFallbackNote(), apifyStage(), ContactAfter, DISCOVERY_SOURCE, discoveryAvailability(), DiscoveryCriteria (+41 more)

### Community 38 - "integrations/catalog.ts"
Cohesion: 0.07
Nodes (31): APOLLO, ACTION_CATEGORIES, compatibleColumns(), CLEANLIST_HANDLERS, CLEANLIST, CONTACTOUT, FINDYMAIL, FULLENRICH (+23 more)

### Community 39 - "endpoints.server.ts"
Cohesion: 0.06
Nodes (56): Ctx, POST(), Ctx, DELETE(), PATCH(), fail(), POST(), readBody() (+48 more)

### Community 40 - "requirePermission"
Cohesion: 0.10
Nodes (30): GET(), POST(), POST(), failure(), GET(), PUT(), failure(), GET() (+22 more)

### Community 41 - "ref_react"
Cohesion: 0.02
Nodes (134): metadata, NewCampaignPage(), AddPeopleToCampaignModal(), PersonRow, CampaignCsvMappingDialog(), Channel, CHANNEL_NAME, exampleFor() (+126 more)

### Community 42 - "requirePageOrgContext"
Cohesion: 0.06
Nodes (59): dynamic, GET(), GET(), NewLinkedInCampaignPage(), ConnectionsPage(), dynamic, initialsOf(), Props (+51 more)

### Community 43 - "websiteContacts.server.ts"
Cohesion: 0.07
Nodes (40): Answer, decode(), DECODED_ENCODINGS, decodedBody(), fetchAnswer(), fetchPublicPage(), notPublic(), PageFetchOptions (+32 more)

### Community 44 - "ref_bun"
Cohesion: 0.07
Nodes (17): STATEMENTS, TABLES, STATEMENTS, EXPECTED_TABLES, TABLES, WIDENED, STATEMENTS, STATEMENTS (+9 more)

### Community 45 - "geocode.server.ts"
Cohesion: 0.14
Nodes (20): checkSearchArea(), distanceMeters(), GeoArea, MAX_SEARCH_HALF_DIAGONAL_KM, MAX_TILES, parseNominatim(), PLACES_PER_SEARCH, searchAreaProblem() (+12 more)

### Community 46 - "unipile.instagram.ts"
Cohesion: 0.18
Nodes (20): POST(), INSTAGRAM_HOSTED_AUTH_RETURN_PATH, instagramHostedAuthCallbackUrls(), hostedAuthCallbackUrls(), call(), createInstagramHostedAuthLink(), instagramAccountStatus(), instagramAccountStatusFromError() (+12 more)

### Community 47 - "calls/campaigns.ts"
Cohesion: 0.06
Nodes (74): DELETE(), GET(), parseStatus(), GET(), POST(), DELETE(), GET(), parseManualCallStatus() (+66 more)

### Community 48 - "grid/schema.ts"
Cohesion: 0.10
Nodes (34): GET(), dynamic, GridIndexPage(), GridLoader(), WorkbookClient, MoveTableDialog(), renderBranch(), toggle() (+26 more)

### Community 49 - "sessions.ts"
Cohesion: 0.07
Nodes (52): POST(), GET(), POST(), POST(), POST(), GET(), applyCallResultToContactSafely(), CallStartedRequest (+44 more)

### Community 50 - "leads/columns.ts"
Cohesion: 0.08
Nodes (58): DELETE(), PATCH(), GET(), create(), GET(), list(), POST(), dynamic (+50 more)

### Community 51 - "whatsapp/messages.ts"
Cohesion: 0.09
Nodes (36): getWhatsappAccountRow(), hasConnectedWhatsappAccount(), BackfillWhatsappAccountResponse, ListWhatsappChatsResponse, WHATSAPP_ACCOUNT_STATUSES, WHATSAPP_MIN_SECONDS_BETWEEN_SENDS, WHATSAPP_NEW_CHAT_WARMUP_HOURS, WHATSAPP_NEW_CHATS_PER_DAY (+28 more)

### Community 52 - "wa-agent.ts"
Cohesion: 0.12
Nodes (42): chatTitle(), clickChatLink(), closeContactForm(), commonAncestor(), confirmedTitles, describeButtons(), dial(), elementWithText() (+34 more)

### Community 53 - "grid/types.ts"
Cohesion: 0.06
Nodes (47): PUT(), saveAimlSettings(), GET(), POST(), AiDialog(), setOutput(), caretRect(), fieldKey() (+39 more)

### Community 54 - "navConfig.ts"
Cohesion: 0.06
Nodes (48): SettingsModalLayout(), metadata, SettingsLayout(), CommandPalette(), change(), go(), activeHref(), allLinks() (+40 more)

### Community 55 - "assistant/outreach.server.ts"
Cohesion: 0.05
Nodes (96): CAMPAIGN_STATUSES, PATCH(), completeStructured(), eligibleAudienceMembers(), inquiryRunMembers(), availableTokens(), BASE_TOKENS, ensureSignOff() (+88 more)

### Community 56 - "classify-legacy-raw-conflicts.ts"
Cohesion: 0.17
Nodes (15): mergedRawByIdentity(), emailFromLeadData(), linkedinFromLeadData(), main(), nonEmpty(), SourceValue, stableValue(), templateTokens() (+7 more)

### Community 57 - "ResultsClient.tsx"
Cohesion: 0.11
Nodes (24): dynamic, GET(), dynamic, metadata, ResultsPage(), NeedsYouPayload, Decision, List() (+16 more)

### Community 58 - "whatsapp/send.ts"
Cohesion: 0.10
Nodes (46): normalizePhone(), findWhatsappAccountByUnipileId(), getDefaultWhatsappAccountRow(), refused(), SendWhatsappRequest, SendWhatsappResponse, recordWhatsappOutboundInCrm(), deliverWhatsappFromCrm() (+38 more)

### Community 59 - "ref_node_fs"
Cohesion: 0.05
Nodes (30): dist, files, filesUnder(), out, zippable, db, db, canonicalFromLeadData() (+22 more)

### Community 60 - "core.ts"
Cohesion: 0.07
Nodes (48): AI_INSTRUCTIONS, CITY_FOR_COUNTRY, COMPANIES, COMPANY_ROWS, companyDomain(), CompanySeed, FEMALE_FIRST, Industry (+40 more)

### Community 61 - "runSearchQueue.ts"
Cohesion: 0.07
Nodes (47): csvEscape(), dynamic, GET(), POST(), POST(), handle(), isStringArray(), POST() (+39 more)

### Community 62 - "assistant/schema.ts"
Cohesion: 0.04
Nodes (71): aiSource, Row, say(), shown(), stamp, Ctx, dynamic, GET() (+63 more)

### Community 63 - "tables.ts"
Cohesion: 0.13
Nodes (28): GET(), dynamic, WorkbookPage(), GRID_PAGE_SIZE, assertKnownColumns(), buildOrderBy(), buildWhere(), GridQuery (+20 more)

### Community 64 - "CompanyResearchModal.tsx"
Cohesion: 0.12
Nodes (21): CompanyResearchModal(), hostOf(), plainAnswer(), Research, ResearchEntry(), STATUS_BADGE, httpUrl(), MAX_CUSTOM_QUESTION_LENGTH (+13 more)

### Community 65 - "dailyRollover.ts"
Cohesion: 0.09
Nodes (54): POST(), POST(), startTrackedJob(), wrapConsoleOnce(), migrationMutationBlockReason(), renewMailboxWatches(), ClaimResult, claimSlot() (+46 more)

### Community 66 - "crm/http.ts"
Cohesion: 0.09
Nodes (41): POST(), PATCH(), POST(), GET(), DELETE(), GET(), Params, PATCH() (+33 more)

### Community 67 - "whatsapp.ts"
Cohesion: 0.08
Nodes (40): replyText(), atBiz(), Beat, CAMPAIGN_A_STEPS, CAMPAIGN_B_STEPS, ChatPlan, digitsOf(), fillCall() (+32 more)

### Community 68 - "SignInForm.tsx"
Cohesion: 0.15
Nodes (24): AcceptInvitationPage(), Invitation, ForgotPasswordPage(), OnboardingPage(), ResetPasswordPage(), ResetPasswordForm(), SetupForm(), accessRequestHref() (+16 more)

### Community 69 - "searchBatches.ts"
Cohesion: 0.08
Nodes (45): DELETE(), isStringArray(), POST(), DELETE(), isUrlRows(), POST(), DELETE(), GET() (+37 more)

### Community 70 - "inOrg"
Cohesion: 0.07
Nodes (61): finalizeDemo(), run(), accountsByCampaignId(), GET(), dynamic, GET(), POST(), GET() (+53 more)

### Community 71 - "read.ts"
Cohesion: 0.06
Nodes (29): dynamic, importPeople(), POST(), HEADERS, GET(), ALIASES, cell(), customFieldKey() (+21 more)

### Community 72 - "CrmConfigurationValidationError"
Cohesion: 0.12
Nodes (22): POST(), GET(), Params, parseNumber(), parseQuery(), Params, POST(), submit() (+14 more)

### Community 73 - "overview.ts"
Cohesion: 0.12
Nodes (29): GET(), outcomeForGroup(), ContactCallStatus, addGroup(), CallGroup, CallOutcome, Counts, DUE_SQL() (+21 more)

### Community 74 - "CrmAiInstructions.tsx"
Cohesion: 0.15
Nodes (18): dynamic, dynamic, InstructionsPage(), metadata, IconButton(), INSTRUCTION_SECTIONS, InstructionField, InstructionRow() (+10 more)

### Community 75 - "webSearch.server.ts"
Cohesion: 0.03
Nodes (135): GET(), GET(), dynamic, errorResponse(), GET(), maxDuration, Params, POST() (+127 more)

### Community 76 - "apify.server.ts"
Cohesion: 0.09
Nodes (41): AccountLimits, apifyReadiness, ApifySettingsError, apifySettingsView(), bounded(), finishRow(), monthStart(), monthUsage() (+33 more)

### Community 77 - "rules.ts"
Cohesion: 0.15
Nodes (24): Ctx, failure(), GET(), PUT(), CHANNEL_RULES, ChannelRuleValues, CHANNELS, ClockRule (+16 more)

### Community 78 - "categories.ts"
Cohesion: 0.09
Nodes (35): GET(), Context, POST(), Context, DELETE(), GET(), GET(), POST() (+27 more)

### Community 79 - "outreach/schema.ts"
Cohesion: 0.04
Nodes (91): ALL_DAY, stamp, accounts, ALL_DAY, gmailAccount, outlookAccount, Recorded, requests (+83 more)

### Community 80 - "mode.ts"
Cohesion: 0.07
Nodes (42): dynamic, GET(), publicOrigin(), dynamic, SetupPage(), SignInPage(), SignUpPage(), safeFrom() (+34 more)

### Community 81 - "results.server.ts"
Cohesion: 0.18
Nodes (20): ChannelSending, n(), one(), results, Row, rows(), emailSendingStatus(), mailboxDailyRoom() (+12 more)

### Community 82 - "LiquidEngine"
Cohesion: 0.11
Nodes (17): Arrow(), clamp(), compile(), computeRect(), DEFAULTS, EngineOptions, hexToRgb(), injectFonts() (+9 more)

### Community 83 - "unipileMail.ts"
Cohesion: 0.11
Nodes (34): dynamic, OutreachLayout(), asAddressList(), dedupeAddresses(), isValidEmail(), MAX_REPLY_EXTRA_RECIPIENTS, MessageRecipients, normalizeEmail() (+26 more)

### Community 84 - "wa-hook.ts"
Cohesion: 0.10
Nodes (37): callDocuments(), CallUi, clockSeconds(), Connect, describe(), Disconnect, findEndButtonIn(), findStatusText() (+29 more)

### Community 85 - "import.ts"
Cohesion: 0.10
Nodes (32): POST(), CellInput, coerceCellInput(), reject(), clipboardCell(), coerceClipboardValue(), parseClipboardText(), parseDelimited() (+24 more)

### Community 86 - "ref_node_assert"
Cohesion: 0.14
Nodes (12): AiInstructionsPurpose, MAX_AI_INSTRUCTION_BLOCKS, MAX_AI_INSTRUCTION_CONTENT_LENGTH, MAX_AI_INSTRUCTION_TITLE_LENGTH, MAX_AI_INSTRUCTIONS_TOTAL_LENGTH, PREAMBLES, renderAiInstructions(), CrmAiInstructions (+4 more)

### Community 87 - "sendFollowUps.ts"
Cohesion: 0.06
Nodes (60): AccountUpdate, PATCH(), resolveProfiles(), CAMPAIGN_MESSAGE_COLS, completeExhaustedLeads(), CUTOFF_COLS, FOLLOW_UP_STAGES, followUpsPerRun() (+52 more)

### Community 88 - "readiness.ts"
Cohesion: 0.11
Nodes (39): dynamic, GettingStartedPage(), metadata, Step(), aiReadiness(), buildReadiness(), campaignsReadiness(), CHANNEL_LABEL (+31 more)

### Community 89 - "auth/server.ts"
Cohesion: 0.08
Nodes (27): cookie(), signIn(), stamp, GET, POST, FullOrg, OrgInvitation, OrgMember (+19 more)

### Community 90 - "organizations.server.ts"
Cohesion: 0.05
Nodes (95): main(), assert(), body, main(), values, POST(), handle(), LogEntry (+87 more)

### Community 91 - "assistant.ts"
Cohesion: 0.06
Nodes (23): automationDone, MAPS_CSV, PAGES, pune, ScraperJob, scraperJobs, stamp, unipileSends (+15 more)

### Community 92 - "quota.server.ts"
Cohesion: 0.13
Nodes (27): backoffMs(), EMPTY_COUNTERS, plural(), ProviderRefusal, QuotaCounters, quotaDecision, QuotaLimits, released() (+19 more)

### Community 93 - "PermanentRunError"
Cohesion: 0.14
Nodes (36): PermanentRunError, assertCleanlistResponse(), buildSearchFilters(), capitalize(), cleanlistErrorMessage(), COMPANY_FILTER_MAP, enrichCompany(), enrichPerson() (+28 more)

### Community 94 - "draft.ts"
Cohesion: 0.06
Nodes (56): AcceptedDraftClassification, buildDraftPrompt(), BuiltDraftPrompt, cleanOptionalText(), cleanRequiredText(), completedActionsFor(), completeDraftWithOpenRouter(), CrmDraftContent (+48 more)

### Community 95 - "leadStage.ts"
Cohesion: 0.06
Nodes (73): LEAD_STAGE_CATEGORIES, LeadStageCategory, syncCallFollowUp(), syncCallFollowUpSafely(), applyStageInTransaction(), applyTranscriptStage(), classifyCallTranscript(), classifyCallTranscriptUnsafe() (+65 more)

### Community 96 - "whatsapp/parse.ts"
Cohesion: 0.11
Nodes (31): WhatsappAccountStatus, asObject(), Attendee, date(), decideIngest(), ECHO_MATCH_WINDOW_MS, flag(), IngestDecision (+23 more)

### Community 97 - "currentOrganizationId"
Cohesion: 0.04
Nodes (120): hash(), identitiesFromLeadData(), main(), APPLY, assertSchemaPrepared(), canonicalLinkedinFromLegacy(), duplicatePlannedMemberships(), emailFromLegacy() (+112 more)

### Community 98 - "linkedin.ts"
Cohesion: 0.10
Nodes (42): REPLY_MIX, count(), workTime(), AccountRow, ALTS, CampaignPlan, chatIdFor(), daysAgoFrac() (+34 more)

### Community 99 - "flags.server.ts"
Cohesion: 0.10
Nodes (35): POST(), PATCH(), GET(), POST(), POST(), GET(), GET(), cache (+27 more)

### Community 100 - "importMapping.ts"
Cohesion: 0.19
Nodes (16): importWhatsappCampaignLeads(), previewWhatsappCampaignUpload(), readSheet(), WhatsappCampaignImportField, campaignPhoneProblem(), FIELD_KEYS, HEADER_ALIASES, headerToCustomKey() (+8 more)

### Community 101 - "ref_server_only"
Cohesion: 0.11
Nodes (17): verifyApolloCredentials(), REQUIRED_SCOPES, verifyCleanlistCredentials(), verifyContactOutCredentials(), verifyFindymailCredentials(), verifyFullEnrichCredentials(), verifyHunterCredentials(), verifyIcypeasCredentials() (+9 more)

### Community 102 - "diagnose-instagram-delivery.ts"
Cohesion: 0.15
Nodes (22): Body, Credentials, flag(), handle(), identifier(), inspectInstagramProvider(), Lookup, main() (+14 more)

### Community 103 - "knowledge-service.ts"
Cohesion: 0.13
Nodes (24): apply, CONTENT, file, seed(), TAGS, Context, GET(), PATCH() (+16 more)

### Community 104 - "engine.ts"
Cohesion: 0.08
Nodes (42): WhatsappCampaignSendStatus, AccountOutcome, deleteClaim(), failClaim(), handleSendFailure(), LeadRow, openLead(), pickDueLead() (+34 more)

### Community 105 - "transcription.ts"
Cohesion: 0.20
Nodes (15): POST(), requireRecordedCall(), audioFormatFor(), buildTranscriptionPrompt(), CallSessionRow, claimForRetry(), finish(), ParsedTranscript (+7 more)

### Community 106 - "services/tinyfish.ts"
Cohesion: 0.13
Nodes (19): TINYFISH_BROWSER_URL, TINYFISH_FETCH_URL, TINYFISH_SEARCH_URL, TinyfishProduct, Bases, call(), createTinyfishBrowserSession(), DEFAULT_BASES (+11 more)

### Community 107 - "tenancy/registry.ts"
Cohesion: 0.10
Nodes (23): apply, dropIfInvalid(), main(), quote(), required(), contract, fail(), main() (+15 more)

### Community 108 - "linkedin.server.ts"
Cohesion: 0.15
Nodes (31): addDays(), bucketFor(), bucketStarts(), dayCount(), LinkedinAnalytics, previousRange(), ratio(), toSeries() (+23 more)

### Community 109 - "grounding.ts"
Cohesion: 0.22
Nodes (14): personalLineProblem(), ClaimKind, CLAIMS, DraftCompletedAction, draftGroundingProblem(), draftLeaks(), draftPlaceholders(), DraftSender (+6 more)

### Community 110 - "test-integrations-live.ts"
Cohesion: 0.11
Nodes (30): actionArgIndex, ActionResult, APOLLO_ORDER, apolloPrerequisites(), baseInputs(), extractApolloArtifacts(), inputIssues(), integrationArgIndex (+22 more)

### Community 111 - "platform/credentials.ts"
Cohesion: 0.06
Nodes (58): apply, env(), FROM_ENV, main(), migratePlatform(), migrateTranscriptionModel(), overwrite, POST() (+50 more)

### Community 112 - "app/layout.tsx"
Cohesion: 0.11
Nodes (21): fontSerif, metadata, RootLayout(), brandDisplay, brandDisplayClass, DemoContext, DemoProvider(), ReadOnlyToast() (+13 more)

### Community 113 - "jobRunner.ts"
Cohesion: 0.12
Nodes (24): output(), CampaignDomainRow, dynamic, GET(), runtime, stream(), CampaignDetailPage(), dynamic (+16 more)

### Community 114 - "providers.ts"
Cohesion: 0.11
Nodes (24): GET(), POST(), Catalog(), ColumnMappingSelect(), EnrichmentDialog(), chooseAction(), removeFilter(), setInputColumn() (+16 more)

### Community 115 - "InquiriesSettings.tsx"
Cohesion: 0.15
Nodes (22): call(), Code(), CopyValue(), EndpointRow(), FieldMapEditor(), formatWhen(), InquiriesSettings(), create() (+14 more)

### Community 116 - "AssistantClient.tsx"
Cohesion: 0.05
Nodes (63): AssistantPage(), dynamic, metadata, ActivityRow(), AssistantAvatar(), AssistantClient(), pickStarter(), send() (+55 more)

### Community 117 - "CampaignLeadsTab.tsx"
Cohesion: 0.17
Nodes (17): CampaignLead, CampaignLeadsTab(), CrossCampaignNotice, InitialLeadsPage, LeadAvatar(), LeadsPagination, LinkedInAccount, MESSAGE_FIELDS (+9 more)

### Community 118 - "instagram.ts"
Cohesion: 0.08
Nodes (20): accountA1, accountA2, accountA3, accountHook(), beforeSendAnswer, callRoute(), chatsByAccount, countA() (+12 more)

### Community 119 - "Sidebar.tsx"
Cohesion: 0.06
Nodes (46): contentType, size, dynamic, InstagramLayout(), metadata, dynamic, LinkedInLayout(), metadata (+38 more)

### Community 120 - "mapping.ts"
Cohesion: 0.12
Nodes (38): ApifyAllowanceInput, firstString(), hashtagsFor(), InstagramProfile, Json, mentionsPlace(), num(), placesFromFacebookItems() (+30 more)

### Community 121 - "outreach/render.ts"
Cohesion: 0.20
Nodes (15): POST(), LeadMessageTemplates, renderLeadTemplates(), appendUnsubscribeFooter(), applySignature(), escapeHtml(), fillTemplate(), RenderableLead (+7 more)

### Community 122 - "web-discovery.ts"
Cohesion: 0.07
Nodes (38): AiCall, aiCalls, aimlAnswer(), blocked, checkOrganizations, citation(), createdMailboxes, createdProviders (+30 more)

### Community 123 - "ChannelSettingsPages.tsx"
Cohesion: 0.09
Nodes (19): dynamic, dynamic, dynamic, dynamic, dynamic, metadata, Page(), dynamic (+11 more)

### Community 124 - "LeadDetailPanel.tsx"
Cohesion: 0.14
Nodes (21): Avatar(), DetailRow(), draftFromLead(), fmt(), LEAD_STATUS_LABELS, LEAD_STATUS_VARIANTS, LeadDetail, LeadDetailPanel() (+13 more)

### Community 125 - "manifest.json"
Cohesion: 0.08
Nodes (25): action, default_icon, default_title, background, service_worker, type, content_scripts, 16 (+17 more)

### Community 126 - "crm/send.ts"
Cohesion: 0.15
Nodes (17): isEmailDoNotContact(), buildThreadHeaders(), CrmSendAdapter, CrmSendAdapterInput, DefiniteCrmSendError, isRfcMessageId(), NormalizedCrmSendResult, PreparedSend (+9 more)

### Community 127 - "[tableId]/export/route.ts"
Cohesion: 0.28
Nodes (10): dynamic, ExportRequest, filenameFor(), POST(), validateStringList(), csvCell(), printableValue(), serializeCsv() (+2 more)

### Community 128 - "tools.server.ts"
Cohesion: 0.04
Nodes (73): dynamic, GET(), SettingsRow, addAudienceMembers(), AudienceSummary, createAudience(), saveMemberInsights(), summarizeAudience() (+65 more)

### Community 129 - "outreachHistory.ts"
Cohesion: 0.16
Nodes (17): BackfillOutreachHistoryInput, BackfillOutreachHistoryResult, EmailOutreachRow, emailOutreachRowToMessageInput(), instagramOutreachRowToMessageInput(), LinkedinOutreachRow, linkedinOutreachRowToMessageInput(), loadEmailOutreachRows() (+9 more)

### Community 130 - "tinyfish.server.ts"
Cohesion: 0.18
Nodes (19): clean(), fetchFailureText(), keyHint(), keyProblem(), searchAnswer, TINYFISH_FREE_LIMITS, TINYFISH_LIMITS, TinyfishFetchFailure (+11 more)

### Community 131 - "analytics/contract.ts"
Cohesion: 0.08
Nodes (36): dynamic, GET(), LOADERS, ANALYTICS_CHANNELS, ANALYTICS_VIEWS, AnalyticsChannel, AnalyticsRange, AnalyticsResponse (+28 more)

### Community 132 - "contacts.ts"
Cohesion: 0.08
Nodes (44): RFC-5321, cleanLinkedinUrl(), contactLinkSequence(), contactPageLinks(), decodeEntities(), DOT_TOKEN, DOT_TOKEN_GLOBAL, extractContacts() (+36 more)

### Community 133 - "tenancy-isolation.ts"
Cohesion: 0.16
Nodes (23): authPost(), cookiesFrom(), fill(), Finding, fingerprintsOfA(), FIXED_PARAMS, foreignKeyColumn(), leaksIn() (+15 more)

### Community 134 - "test-people-crm-core.ts"
Cohesion: 0.13
Nodes (21): resolveScriptOrganization(), assertCore(), DatabaseError, errorCode(), EXPECTED_TABLES, expectRejected(), main(), runWithSavepoint() (+13 more)

### Community 135 - "auth/schema.ts"
Cohesion: 0.06
Nodes (33): dynamic, POST(), create(), onName(), submit(), accounts, authSchema, Member (+25 more)

### Community 136 - "LinkedInAccountTag"
Cohesion: 0.27
Nodes (7): LinkedInAccountRef, LinkedInAccountTag(), QuotaLabel(), SearchAccountPicker(), renderCheckboxRow(), SenderAccount, SenderAccountAvatar()

### Community 137 - "src/messages.ts"
Cohesion: 0.13
Nodes (18): extensionAlive(), onMessage(), reply(), scope, ActiveCall, AgentCommand, BackgroundMessage, BridgeCommand (+10 more)

### Community 138 - "repository.ts"
Cohesion: 0.11
Nodes (27): compareCandidates(), DEFAULT_KNOWLEDGE_TOKENS, estimateKnowledgeTokens(), hashExcerpt, hashKnowledgeExcerpt(), KNOWLEDGE_CHARS_PER_TOKEN, KnowledgeCandidate, KnowledgeCitation (+19 more)

### Community 139 - "ai/server/types.ts"
Cohesion: 0.21
Nodes (15): runAnthropic(), callGemini(), GeminiPart, GeminiResponse, runGoogle(), runGoogleImage(), asPermanent(), client() (+7 more)

### Community 140 - "whatsapp/accounts.ts"
Cohesion: 0.14
Nodes (20): GET(), defaultLockKey(), ensureDefaultAccount(), listWhatsappAccounts(), setDefaultWhatsappAccount(), setWhatsappNewChatsPerDay(), syncWhatsappAccounts(), toWhatsappAccountSummary() (+12 more)

### Community 141 - "ChannelRulesForm.tsx"
Cohesion: 0.21
Nodes (15): ChannelRulesForm(), COMMON_TIMEZONES, CountryInput(), countryName(), DAY_LABELS, describeDefault(), HoursInput(), hoursSummary() (+7 more)

### Community 142 - "linkedin/LeadsClient.tsx"
Cohesion: 0.19
Nodes (11): LeadBulkActionBar(), Account, InitialData, Lead, Pagination, STATUS_LABELS, STATUS_VARIANTS, LeadSelectCheckbox() (+3 more)

### Community 143 - "platform/catalog.ts"
Cohesion: 0.08
Nodes (33): watchRegistration(), GmailWatchRegistration, OPENROUTER_ICON_URL, PLATFORM_INTEGRATIONS, PLATFORM_SETTINGS_HREF, PLATFORM_SETTINGS_LABEL, PlatformCredentials, PlatformField (+25 more)

### Community 144 - "migrationParity.ts"
Cohesion: 0.18
Nodes (20): DbRow, hash(), main(), REPORT, action(), classifyWebhookOwnership(), compareEligibleAccountIds(), compareLinkedinLead() (+12 more)

### Community 145 - "ConnectionSettingsPage"
Cohesion: 0.18
Nodes (9): dynamic, dynamic, dynamic, metadata, Page(), dynamic, metadata, Page() (+1 more)

### Community 146 - "campaigns/CampaignDetailClient.tsx"
Cohesion: 0.13
Nodes (16): ActiveJobInfo, CampaignDetailClient(), CampaignInfo, DebugSidePanel(), DomainRow, formatRevenue(), formatTimestamp(), JsonBlock() (+8 more)

### Community 147 - "results.ts"
Cohesion: 0.24
Nodes (11): writeDailySummary(), sourceLabel(), dayLabel(), dayStart(), Period, periodFor(), organizationTimeZone(), SourceYield (+3 more)

### Community 148 - "e2e/tinyfish.ts"
Cohesion: 0.18
Nodes (7): Call, calls, json(), nextFetch(), nextSearch(), scope, stamp

### Community 149 - "instagram/parse.ts"
Cohesion: 0.13
Nodes (26): INSTAGRAM_FRESH_MESSAGE_WINDOW_MS, asObject(), Attendee, ChatOpeningCheck, date(), ECHO_MATCH_WINDOW_MS, flag(), IngestDecision (+18 more)

### Community 150 - "unsubscribeToken.ts"
Cohesion: 0.33
Nodes (9): buildLegacyUnsubscribeToken(), buildUnsubscribeToken(), secret(), sign(), signatureMatches(), signLegacy(), signV2(), UnsubscribeTokenResult (+1 more)

### Community 151 - "audit-email-people-parity.ts"
Cohesion: 0.13
Nodes (17): compareEmailParityRow(), legacyEmailVariables(), main(), ParityRow, pendingSteps(), SequenceStep, substituteVariables(), base (+9 more)

### Community 152 - "guardedSearch"
Cohesion: 0.27
Nodes (10): lockedState(), reserveQuota(), settleQuota(), writeState(), fetchWithTinyfish(), guardedSearch(), recordRefusal(), searchWithTinyfish() (+2 more)

### Community 153 - "qualification/campaigns.ts"
Cohesion: 0.10
Nodes (37): create(), POST(), addManualCandidates(), baseCampaignName(), cleanNamePart(), COUNTRY_LABELS, createCampaign(), CreateCampaignInput (+29 more)

### Community 154 - "whatsapp.server.ts"
Cohesion: 0.18
Nodes (10): WhatsappAnalytics, WhatsappCallOutcome, CallRow, CampaignCallRow, CLASS_ERROR, ERROR_CLASS, LIVE_MESSAGE, OUTCOME_LABELS (+2 more)

### Community 155 - "tinyfish/route.ts"
Cohesion: 0.50
Nodes (7): failure(), GET(), PUT(), saveTinyfishSettings(), TinyfishSettingsError, tinyfishSettingsView(), verifyKey()

### Community 156 - "ref_bun_test"
Cohesion: 0.18
Nodes (8): inbound, outbound, createLimiter(), CATEGORY, leadProgress, LeadProgressInput, replied(), base

### Community 157 - "cn"
Cohesion: 0.17
Nodes (11): Badge(), BadgeProps, badgeVariants, Dialog, DialogClose, DialogContent(), DialogHeader(), DialogOverlay() (+3 more)

### Community 158 - "e2e/apify.ts"
Cohesion: 0.12
Nodes (11): apify, AssistantJob, context, createdProviders, mapsItems, RunScript, runToEnd(), scraperJobs (+3 more)

### Community 159 - "qualification/index.ts"
Cohesion: 0.16
Nodes (16): csvEscape(), dynamic, exportCampaigns(), GET(), csvEscape(), dynamic, exportCampaign(), GET() (+8 more)

### Community 160 - "mailDomain.server.ts"
Cohesion: 0.20
Nodes (13): RFC-7505, clearMailDomainCache(), definitelyNone(), domainCache, DomainCheck, hasAddressRecord(), MailDns, mailDomainCheck (+5 more)

### Community 161 - "options.ts"
Cohesion: 0.31
Nodes (14): refreshBridges(), syncCustomBridges(), addOrigin(), removeOrigin(), render(), row(), setStatus(), allowedOrigins() (+6 more)

### Community 162 - "lib/queries.ts"
Cohesion: 0.32
Nodes (6): GET(), DomainsParams, DomainsResult, DomainsRow, getDomains(), NULL_CATEGORY

### Community 163 - "analytics/route.ts"
Cohesion: 0.28
Nodes (14): ActivitySlot, applyOutboundMessage(), emptySlot(), GET(), tallyOutboundTotals(), addCalendarDays(), CalendarDate, calendarDayBoundsInZone() (+6 more)

### Community 164 - "templates.ts"
Cohesion: 0.46
Nodes (6): CONTACT_CALL_STATUS_DEFINITIONS, CONTACT_CALL_STATUSES, followUpMessageFor(), greetingName(), renderTemplate(), TemplateLead

### Community 165 - "endCall"
Cohesion: 0.60
Nodes (6): endCall(), finish(), onResult(), probe(), finish(), onResult()

### Community 166 - "update.ts"
Cohesion: 0.26
Nodes (15): chooseFolder(), download(), FolderHandle, notThisExtension(), openStore(), PermissionMode, render(), running (+7 more)

### Community 167 - "intake.ts"
Cohesion: 0.14
Nodes (7): deliver(), janeBody, json(), manage(), person(), Reply, stamp

### Community 174 - "leadImport.ts"
Cohesion: 0.21
Nodes (16): POST(), importRuns, cell(), EmailCsvMapping, importLeadsForCampaign(), ImportResult, MAX_IMPORT_ROWS, normalizeHeader() (+8 more)

### Community 176 - "lusha/actions.ts"
Cohesion: 0.33
Nodes (15): collectSignals(), COMPANY_SIGNAL_TYPES, errorText(), executeCompanySignal(), executeEnrichCompany(), executeEnrichPerson(), executePersonSignals(), finish() (+7 more)

### Community 177 - "apollo.ts"
Cohesion: 0.33
Nodes (12): apolloSearchWithDebug(), appendDomainParams(), countAllPeople(), countLeads(), countLeadsWithDebug(), countVerifiedPeople(), normalizeDomains(), paramsToRecord() (+4 more)

### Community 179 - "ByokSettingsClient.tsx"
Cohesion: 0.03
Nodes (77): dynamic, Loading(), AiSettingsPage(), dynamic, metadata, Loading(), Loading(), Loading() (+69 more)

### Community 181 - "instagramUsername"
Cohesion: 0.19
Nodes (14): definiteInstagramRefusal(), deliverInitialInstagramDm(), InitialDm, InitialDmEffects, instagramRecipient, job, instagramUsername(), instagramOutreachTransport() (+6 more)

### Community 183 - "asRecord"
Cohesion: 0.14
Nodes (31): hunterError(), delay(), execute(), FAILED, formatLocation(), NOT_FOUND, PENDING, request() (+23 more)

### Community 184 - "ReplyComposer.tsx"
Cohesion: 0.20
Nodes (7): escapeHtml(), Recipient, RecipientChips(), ReplyComposer(), ReplyComposerProps, textToHtml(), ToolbarButton()

### Community 187 - "DomainsTable.tsx"
Cohesion: 0.43
Nodes (5): DomainsTable(), fmt(), PageBtn(), Props, ExportModal()

### Community 188 - "socialAdapters.ts"
Cohesion: 0.18
Nodes (6): configuredSocialAdapters(), MetaGraphCredentials, metaGraphHashtagAdapter(), normalizeHashtag(), SocialKeywordAdapter, SocialMediaItem

### Community 189 - "CreateCampaignForm.tsx"
Cohesion: 0.19
Nodes (9): COUNTRY_OPTIONS, CreateCampaignForm(), Label(), MODE_OPTIONS, PLATFORM_OPTIONS, TARGET_MODE_OPTIONS, Props, Select() (+1 more)

### Community 190 - "apollo/actions.ts"
Cohesion: 0.32
Nodes (12): ApolloRequest, buildApolloRequest(), compactRecord(), contactFields(), contactOutput(), executeApollo(), extractApolloOutputs(), hasApolloResult() (+4 more)

### Community 191 - "sendFromInbox.test.ts"
Cohesion: 0.24
Nodes (9): InboxCrmConversation, InboxSendConnection, InboxSendDependencies, InboxSendError, InboxSentMessage, sendFromLinkedinInbox(), connection, crmConversation (+1 more)

### Community 192 - "ads.ts"
Cohesion: 0.24
Nodes (8): AdsCheckInput, AdsCheckResult, AdsProvider, checkAds(), getAdsProvider(), httpAdsProvider(), mockAdsProvider, env

### Community 194 - "audit-linkedin-message-duplicates.ts"
Cohesion: 0.23
Nodes (9): AuditRow, AUTOMATED_TYPES, AutomatedMessageType, main(), Recommendation, recommendSurvivor(), redact(), RedactedMessage (+1 more)

### Community 196 - "export-people-migration-reconciliation.ts"
Cohesion: 0.36
Nodes (10): appSha(), arg(), Cursor, expectedInteger(), main(), parseCursor(), required(), safeRunId() (+2 more)

### Community 197 - "mark-linkedin-message-duplicates.ts"
Cohesion: 0.29
Nodes (8): buildDecisions(), confirmationArgument(), decideDuplicateGroup(), DuplicateDecision, loadDuplicateRows(), main(), MessageRow, numericArgument()

### Community 198 - "rotate-integration-credentials.ts"
Cohesion: 0.31
Nodes (10): APPLY, CredentialObject, CredentialRow, decrypt(), derivedKey(), encrypt(), fingerprint(), main() (+2 more)

### Community 200 - "WhatsappSequenceEditor"
Cohesion: 0.33
Nodes (11): newStep(), stepLabel(), WhatsappSequenceEditor(), addFollowUp(), change(), insertToken(), move(), remove() (+3 more)

### Community 201 - "rollback-people-migration.ts"
Cohesion: 0.38
Nodes (9): appSha(), arg(), Counts, expectedInteger(), inspect(), main(), Phase, required() (+1 more)

### Community 203 - "add-mailboxes.ts"
Cohesion: 0.31
Nodes (7): capitalize(), DOMAINS, file, main(), Result, signatureFor(), TARGETS

### Community 204 - "domains/page.tsx"
Cohesion: 0.24
Nodes (11): DomainsPage(), getQueryParams(), Params, SearchParams, TableSection(), NavContext, NavCtx, NavigationProvider() (+3 more)

### Community 205 - "CategoryFilter.tsx"
Cohesion: 0.28
Nodes (7): CategoryFilter(), CategorySelect(), CountMap, fmt(), NULL_CATEGORY, Props, SelectProps

### Community 206 - "Filters.tsx"
Cohesion: 0.15
Nodes (12): ALL_APPS, AppFilter(), fmt(), Props, COUNTRY_OPTIONS, DIR_OPTIONS, Filters(), Label() (+4 more)

### Community 207 - "searchLeadLimit.ts"
Cohesion: 0.22
Nodes (11): FilterSelect(), FilterSelectOption, FilterSelectProps, limitRingClass(), OptionAvatar(), assertSearchQuotaAvailable(), DAILY_SEARCH_LEAD_LIMIT, getSearchRemainingTier() (+3 more)

### Community 209 - "owner-controls.ts"
Cohesion: 0.32
Nodes (5): call(), cookiesFrom(), privileged, signIn(), sql

### Community 210 - "finalize-lead-tables.ts"
Cohesion: 0.36
Nodes (7): assertPrepared(), Blocker, BLOCKER_QUERIES, findBlockers(), findInvalidIndexes(), main(), UNIQUE_INDEXES

### Community 211 - "app/campaigns/page.tsx"
Cohesion: 0.32
Nodes (5): CampaignsPage(), dynamic, CampaignListClient(), StatusBadge(), listCampaigns()

### Community 213 - "add-category-columns.js"
Cohesion: 0.33
Nodes (6): envPath, fs, main(), path, postgres, sql

### Community 214 - "normalize-targeted-domains.js"
Cohesion: 0.33
Nodes (6): { Client }, envPath, fs, main(), normalizeDomain(), path

### Community 215 - "precompute-category-counts.js"
Cohesion: 0.33
Nodes (6): envPath, fs, main(), path, postgres, sql

### Community 217 - "unsubscribe/page.tsx"
Cohesion: 0.47
Nodes (3): dynamic, UnsubscribePage(), UnsubscribeClient()

### Community 218 - "leadsTemplate.ts"
Cohesion: 0.47
Nodes (4): GET(), buildLeadsTemplateBuffer(), campaignLeadTemplateFilename(), TEMPLATE_SAMPLE_ROW

### Community 221 - "LeadActivityPanel.tsx"
Cohesion: 0.10
Nodes (24): NewWorkbookDialog(), createBlank(), createFromFile(), createWorkbook(), buildSequence(), buildTimeline(), Email, fullDate() (+16 more)

### Community 222 - "ref_next"
Cohesion: 0.07
Nodes (5): GET(), GET(), dynamic, listCrmIdentityExceptions(), getCrmOverview()

## Knowledge Gaps
- **17 isolated node(s):** `RFC-6901`, `RFC-8058`, `RFC-4180`, `RFC-3464`, `RFC-8058` (+12 more)
  These have ≤1 connection - possible missing edges. (Counts symbols only; 2592 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **15 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `inOrg()` connect `inOrg` to `tenancy/scope.ts`, `tools.server.ts`, `sequences.ts`, `outreachHistory.ts`, `runInOrganization`, `tinyfish.server.ts`, `withOrgContext`, `grid/columns.ts`, `demo/email.ts`, `whatsapp/accounts.ts`, `crm/schema.ts`, `grid/worker.ts`, `assistant/agent.server.ts`, `crm.ts`, `webDiscovery.server.ts`, `instagram/messages.ts`, `autopilotRun.server.ts`, `qualification/campaigns.ts`, `decisions.server.ts`, `handlers.ts`, `guardedSearch`, `conversations.ts`, `http.server.ts`, `fields.ts`, `qualification/index.ts`, `treg.server.ts`, `analytics/route.ts`, `campaigns.server.ts`, `discovery.server.ts`, `endpoints.server.ts`, `requirePageOrgContext`, `leadImport.ts`, `calls/campaigns.ts`, `grid/schema.ts`, `sessions.ts`, `leads/columns.ts`, `whatsapp/messages.ts`, `grid/types.ts`, `assistant/outreach.server.ts`, `ResultsClient.tsx`, `whatsapp/send.ts`, `runSearchQueue.ts`, `assistant/schema.ts`, `tables.ts`, `dailyRollover.ts`, `crm/http.ts`, `searchBatches.ts`, `webSearch.server.ts`, `apify.server.ts`, `categories.ts`, `outreach/schema.ts`, `results.server.ts`, `unipileMail.ts`, `app/campaigns/page.tsx`, `sendFollowUps.ts`, `organizations.server.ts`, `quota.server.ts`, `draft.ts`, `leadStage.ts`, `ref_next`, `currentOrganizationId`, `flags.server.ts`, `knowledge-service.ts`, `engine.ts`, `transcription.ts`, `platform/credentials.ts`, `jobRunner.ts`, `providers.ts`, `mapping.ts`, `outreach/render.ts`, `web-discovery.ts`, `crm/send.ts`?**
  _High betweenness centrality (0.088) - this node is a cross-community bridge._
- **What connects `RFC-6901`, `RFC-8058`, `RFC-4180` to the rest of the system?**
  _17 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `tenancy/scope.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.028833551769331587 - nodes in this community are weakly interconnected._
- **Why does `cn()` connect `cn` to `ref_remixicon_react`, `CrmActionsClient.tsx`, `MessagesLayout.tsx`, `Frame`, `WorkbookListClient.tsx`, `CampaignClient.tsx`, `Skeleton`, `ChannelRulesForm.tsx`, `alignui/badge.tsx`, `WhatsappCampaignsClient.tsx`, `campaigns.server.ts`, `ref_react`, `requirePageOrgContext`, `leads/columns.ts`, `ByokSettingsClient.tsx`, `navConfig.ts`, `ReplyComposer.tsx`, `ResultsClient.tsx`, `SignInForm.tsx`, `WhatsappSequenceEditor`, `CrmAiInstructions.tsx`, `LeadActivityPanel.tsx`, `InquiriesSettings.tsx`, `AssistantClient.tsx`, `CampaignLeadsTab.tsx`, `Sidebar.tsx`?**
  _High betweenness centrality (0.048) - this node is a cross-community bridge._
- **Should `runInOrganization` be split into smaller, more focused modules?**
  _Cohesion score 0.11859979101358412 - nodes in this community are weakly interconnected._
- **Why does `db` connect `tenancy/scope.ts` to `sequences.ts`, `withOrgContext`, `grid/columns.ts`, `demo/email.ts`, `crm/schema.ts`, `grid/worker.ts`, `assistant/agent.server.ts`, `crm.ts`, `webDiscovery.server.ts`, `instagram/messages.ts`, `autopilotRun.server.ts`, `decisions.server.ts`, `handlers.ts`, `conversations.ts`, `http.server.ts`, `treg.server.ts`, `workspace.ts`, `campaigns.server.ts`, `discovery.server.ts`, `endpoints.server.ts`, `requirePageOrgContext`, `calls/campaigns.ts`, `grid/schema.ts`, `sessions.ts`, `leads/columns.ts`, `whatsapp/messages.ts`, `grid/types.ts`, `assistant/outreach.server.ts`, `whatsapp/send.ts`, `core.ts`, `runSearchQueue.ts`, `assistant/schema.ts`, `tables.ts`, `dailyRollover.ts`, `whatsapp.ts`, `searchBatches.ts`, `inOrg`, `overview.ts`, `webSearch.server.ts`, `apify.server.ts`, `categories.ts`, `outreach/schema.ts`, `mode.ts`, `results.server.ts`, `import.ts`, `ref_node_assert`, `sendFollowUps.ts`, `auth/server.ts`, `organizations.server.ts`, `assistant.ts`, `quota.server.ts`, `draft.ts`, `leadStage.ts`, `currentOrganizationId`, `linkedin.ts`, `flags.server.ts`, `knowledge-service.ts`, `engine.ts`, `transcription.ts`, `linkedin.server.ts`, `platform/credentials.ts`, `jobRunner.ts`, `providers.ts`, `web-discovery.ts`, `crm/send.ts`, `tools.server.ts`, `tinyfish.server.ts`, `analytics/contract.ts`, `auth/schema.ts`, `repository.ts`, `whatsapp/accounts.ts`, `results.ts`, `qualification/campaigns.ts`, `whatsapp.server.ts`, `lib/queries.ts`, `analytics/route.ts`, `leadImport.ts`?**
  _High betweenness centrality (0.036) - this node is a cross-community bridge._
- **Should `sequences.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.052342423334332235 - nodes in this community are weakly interconnected._