# Graph Report - AgentSDR  (2026-10-18)

## Corpus Check
- Large corpus: 1770 files · ~1,875,120 words. Semantic extraction will be expensive (many Claude tokens). Consider running on a subfolder.

## Summary
- 9920 nodes · 36288 edges · 239 communities (223 shown, 16 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 228 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Community 0
- Community 1
- Community 2
- Community 3
- Community 4
- Community 5
- Community 6
- Community 7
- Community 8
- Community 9
- Community 10
- Community 11
- Community 12
- Community 13
- Community 14
- Community 15
- Community 16
- Community 17
- Community 18
- Community 19
- Community 20
- Community 21
- Community 22
- Community 23
- Community 24
- Community 25
- Community 26
- Community 27
- Community 28
- Community 29
- Community 30
- Community 31
- Community 32
- Community 33
- Community 34
- Community 35
- Community 36
- Community 37
- Community 38
- Community 39
- Community 40
- Community 41
- Community 42
- Community 43
- Community 44
- Community 45
- Community 46
- Community 47
- Community 48
- Community 49
- Community 50
- Community 51
- Community 52
- Community 53
- Community 54
- Community 55
- Community 56
- Community 57
- Community 58
- Community 59
- Community 60
- Community 61
- Community 62
- Community 63
- Community 64
- Community 65
- Community 66
- Community 67
- Community 68
- Community 69
- Community 70
- Community 71
- Community 72
- Community 73
- Community 74
- Community 75
- Community 76
- Community 77
- Community 78
- Community 79
- Community 80
- Community 81
- Community 82
- Community 83
- Community 84
- Community 85
- Community 86
- Community 87
- Community 88
- Community 89
- Community 90
- Community 91
- Community 92
- Community 93
- Community 94
- Community 95
- Community 96
- Community 97
- Community 98
- Community 99
- Community 100
- Community 101
- Community 102
- Community 103
- Community 104
- Community 105
- Community 106
- Community 107
- Community 108
- Community 109
- Community 110
- Community 111
- Community 112
- Community 113
- Community 114
- Community 115
- Community 116
- Community 117
- Community 118
- Community 119
- Community 120
- Community 121
- Community 122
- Community 123
- Community 124
- Community 125
- Community 126
- Community 127
- Community 128
- Community 129
- Community 130
- Community 131
- Community 132
- Community 133
- Community 134
- Community 135
- Community 136
- Community 137
- Community 138
- Community 139
- Community 140
- Community 141
- Community 142
- Community 143
- Community 144
- Community 145
- Community 146
- Community 147
- Community 148
- Community 149
- Community 150
- Community 151
- Community 152
- Community 153
- Community 154
- Community 155
- Community 156
- Community 157
- Community 158
- Community 159
- Community 160
- Community 161
- Community 162
- Community 163
- Community 164
- Community 165
- Community 166
- Community 167
- Community 168
- Community 169
- Community 170
- Community 171
- Community 172
- Community 173
- Community 174
- Community 175
- Community 176
- Community 177
- Community 178
- Community 179
- Community 180
- Community 181
- Community 182
- Community 183
- Community 184
- Community 185
- Community 186
- Community 187
- Community 188
- Community 189
- Community 190
- Community 191
- Community 192
- Community 193
- Community 194
- Community 195
- Community 196
- Community 197
- Community 198
- Community 199
- Community 200
- Community 201
- Community 202
- Community 203
- Community 204
- Community 205
- Community 206
- Community 207
- Community 208
- Community 209
- Community 210
- Community 211
- Community 212
- Community 213
- Community 214
- Community 215
- Community 216
- Community 217
- Community 218
- Community 219
- Community 220
- Community 221
- Community 222
- Community 223
- Community 224
- Community 225
- Community 226
- Community 227
- Community 228
- Community 229
- Community 230
- Community 231
- Community 232
- Community 237
- Community 238

## God Nodes (most connected - your core abstractions)
1. `inOrg()` - 668 edges
2. `cn()` - 398 edges
3. `currentOrganizationId()` - 296 edges
4. `withOrgContext()` - 286 edges
5. `db` - 235 edges
6. `runInOrganization()` - 234 edges
7. `authContextErrorResponse()` - 230 edges
8. `Frame()` - 148 edges
9. `FramePanel()` - 148 edges
10. `FrameHeader()` - 109 edges

## Surprising Connections (you probably didn't know these)
- `act()` --indirect_call--> `answer()`  [INFERRED]
  src/components/assistant/NeedsYouList.tsx → extensions/whatsapp-recorder/src/wa-hook.ts
- `act()` --indirect_call--> `answer()`  [INFERRED]
  src/components/assistant/AssistantClient.tsx → extensions/whatsapp-recorder/src/wa-hook.ts
- `handleBridge()` --calls--> `digitsOnly()`  [EXTRACTED]
  extensions/whatsapp-recorder/src/background.ts → src/lib/calls/digits.ts
- `main()` --calls--> `connectMailbox()`  [EXTRACTED]
  scripts/add-mailboxes.ts → src/lib/outreach/mailboxes.ts
- `compareEmailParityRow()` --calls--> `personVariables()`  [EXTRACTED]
  scripts/audit-email-people-parity.ts → src/lib/leads/variables.ts

## Import Cycles
- None detected.

## Communities (239 total, 16 thin omitted)

### Community 0 - "Community 0"
Cohesion: 0.02
Nodes (247): main(), stamp, Check, runAutomationChecks(), runIsolationChecks(), ALL_DAY, stamp, stamp (+239 more)

### Community 1 - "Community 1"
Cohesion: 0.04
Nodes (188): POST(), POST(), parseAddCampaignContactRequest(), POST(), DELETE(), GET(), parseStatus(), parseUpdateCampaignRequest() (+180 more)

### Community 2 - "Community 2"
Cohesion: 0.03
Nodes (209): dryRun, main(), ChannelTotals, main(), dryRun, main(), partA(), partB() (+201 more)

### Community 3 - "Community 3"
Cohesion: 0.02
Nodes (184): dynamic, dynamic, KnowledgePage(), metadata, AiBrandIcon(), AzureMark(), Brand, brandFor() (+176 more)

### Community 4 - "Community 4"
Cohesion: 0.02
Nodes (198): CrmActionsPage(), metadata, CrmPipelinePage(), metadata, CrmRecordPage(), CrmSequencePage(), CrmSequencesPage(), metadata (+190 more)

### Community 5 - "Community 5"
Cohesion: 0.03
Nodes (193): CallingMessagesPage(), dynamic, metadata, dynamic, InboxPage(), metadata, dynamic, metadata (+185 more)

### Community 6 - "Community 6"
Cohesion: 0.04
Nodes (153): BarList(), BarListItem, CapacityMeter(), TONES, ChartCard(), ChartLegend(), LegendItem, DataTableView() (+145 more)

### Community 7 - "Community 7"
Cohesion: 0.03
Nodes (141): dynamic, GettingStartedPage(), metadata, Section(), Step(), dynamic, InstagramMessagesPage(), metadata (+133 more)

### Community 8 - "Community 8"
Cohesion: 0.04
Nodes (105): GET(), GET(), DELETE(), POST(), GET(), GET(), GET(), GET() (+97 more)

### Community 9 - "Community 9"
Cohesion: 0.04
Nodes (137): CallCampaignPage(), CallCampaignsPage(), metadata, ErrorState(), attemptHint(), Avatar(), AVATAR_TONES, AvatarInner() (+129 more)

### Community 10 - "Community 10"
Cohesion: 0.03
Nodes (130): Content, Item, ItemIcon(), Separator, Body(), CloseIcon(), Content, Description (+122 more)

### Community 11 - "Community 11"
Cohesion: 0.04
Nodes (69): Loading(), Loading(), Loading(), Loading(), Loading(), CrmRecordLoading(), Loading(), Loading() (+61 more)

### Community 12 - "Community 12"
Cohesion: 0.05
Nodes (112): RFC-6901, resolveCell(), RUN_COLUMN_TYPES, POST(), promptColumnKeys(), AiColumnInput, createAiColumns(), ownOutputColumns() (+104 more)

### Community 13 - "Community 13"
Cohesion: 0.04
Nodes (99): RFC-3464, BOUNCE_LOCAL_PARTS, main(), dryRun, main(), apply, main(), BOUNCE_LOCAL_PARTS (+91 more)

### Community 14 - "Community 14"
Cohesion: 0.03
Nodes (93): AVATAR_ROOT_NAME, AvatarImage, AvatarImageProps, AvatarIndicator(), AvatarRoot, AvatarRootProps, AvatarSharedProps, AvatarStatus() (+85 more)

### Community 15 - "Community 15"
Cohesion: 0.03
Nodes (92): GET(), CRM_ACTION_GROUP_LABELS, CRM_ACTION_GROUPS, CrmActionGroup, isCrmActionGroup(), crmActionableSql(), crmActionGroupSql(), CrmRecordColumns (+84 more)

### Community 16 - "Community 16"
Cohesion: 0.04
Nodes (91): AddColumnMenu(), ColumnConfigDialog(), ColumnPicker(), emptySubscribe(), Field(), formatPreview(), HeaderPair, PreviewState (+83 more)

### Community 17 - "Community 17"
Cohesion: 0.05
Nodes (80): AddPeopleToCampaignModal(), PersonRow, CampaignCsvMappingDialog(), exampleFor(), formatElapsed(), Account, LinkedInCampaignWizard(), StepDot() (+72 more)

### Community 18 - "Community 18"
Cohesion: 0.03
Nodes (86): LiveCallCandidate, selectLiveCallId(), NOW, COLOR, CALL_STATUS_LABEL, CALL_STATUS_TONE, addCampaignContact(), assertCampaignExists() (+78 more)

### Community 19 - "Community 19"
Cohesion: 0.05
Nodes (80): DELETE(), hasRequiredInputs(), POST(), validateEnrichmentAccounts(), CascadeColumn, cascadeTargets(), readyDependents(), RowChange (+72 more)

### Community 20 - "Community 20"
Cohesion: 0.05
Nodes (86): actionsProblem(), actsOnOutreach(), AgentAction, AgentReply, agentReplySchema(), cleanSuggestions(), CONFIRMATION_CORE, CONFIRMATIONS (+78 more)

### Community 21 - "Community 21"
Cohesion: 0.04
Nodes (81): AFTERNOON, atWork(), awaitingDraft(), backdateConfiguration(), buildPlans(), businessTime(), cap(), Chan (+73 more)

### Community 22 - "Community 22"
Cohesion: 0.05
Nodes (80): contactLinkSequence(), discoveryPageOptions(), anchorsOf(), buildSearchQueries(), classifySourceUrl(), clip(), directoryBusinessLinks(), directoryListingContacts() (+72 more)

### Community 23 - "Community 23"
Cohesion: 0.06
Nodes (74): ImportInstagramHistoryResponse, INSTAGRAM_ACCOUNT_STATUSES, INSTAGRAM_FRESH_MESSAGE_WINDOW_MS, INSTAGRAM_NO_TEXT_BODY, InstagramAccountStatus, InstagramAttachment, InstagramChatSource, InstagramChatSummary (+66 more)

### Community 24 - "Community 24"
Cohesion: 0.06
Nodes (70): writeBrief(), CHANNEL_RULES, nextStepOf(), AGENT_ACTIONS, AGENT_CATEGORIES, AgentAction, AgentChannel, AgentDecision (+62 more)

### Community 25 - "Community 25"
Cohesion: 0.03
Nodes (53): { Client }, envContent, envPath, fs, path, { Client }, envPath, fs (+45 more)

### Community 26 - "Community 26"
Cohesion: 0.05
Nodes (63): finalizeDemo(), AgentModel, CrmJob, CrmSendAdapter, deps, prompts, script, Scripted (+55 more)

### Community 27 - "Community 27"
Cohesion: 0.05
Nodes (57): check(), runScenario(), WAIT_MS, waitFor(), dryRun, main(), AiInstructionsPurpose, formatAiInstructions() (+49 more)

### Community 28 - "Community 28"
Cohesion: 0.03
Nodes (17): STATEMENTS, DEFAULT_STAGE_RANKS, WIDENED, TABLES, FINAL_INDEXES, PREPARED_INDEXES, REQUIRED_COLUMNS, CORE_COLUMNS (+9 more)

### Community 29 - "Community 29"
Cohesion: 0.08
Nodes (64): Ctx, dynamic, POST(), CAMPAIGN_STATUSES, DELETE(), PATCH(), eligibleAudienceMembers(), inquiryRunMembers() (+56 more)

### Community 30 - "Community 30"
Cohesion: 0.06
Nodes (54): OutreachPlan, stamp, Ctx, dynamic, POST(), attachmentSummary(), dynamic, POST() (+46 more)

### Community 31 - "Community 31"
Cohesion: 0.07
Nodes (56): fail(), POST(), readBody(), tokenOf(), organizationPhoneCountry(), FeatureDisabledError, cleanJson(), cleanString() (+48 more)

### Community 32 - "Community 32"
Cohesion: 0.07
Nodes (58): activeCallWrites, awaitingReturn, callForTab(), clearActiveCall(), endCall(), finishActiveCall(), focusApp(), focusTab() (+50 more)

### Community 33 - "Community 33"
Cohesion: 0.12
Nodes (51): CellResult, EnrichmentConfig, APOLLO_HANDLERS, CONTACTOUT_HANDLERS, executeContactOut(), stringList(), executeFindymail(), FINDYMAIL_HANDLERS (+43 more)

### Community 34 - "Community 34"
Cohesion: 0.07
Nodes (48): Call, CATALOG, stamp, treg, failure(), GET(), PUT(), callCeilingUsd() (+40 more)

### Community 35 - "Community 35"
Cohesion: 0.06
Nodes (57): addMs(), count(), workTime(), Account, ANGLE_BY_INDUSTRY, apolloDebug(), apolloTrace(), BADGES (+49 more)

### Community 36 - "Community 36"
Cohesion: 0.07
Nodes (54): DEFAULT_FIELDS, Unit, save(), launchWhatsapp(), assertAccountsInOrg(), assertSteps(), CampaignRow, CompanyRow (+46 more)

### Community 37 - "Community 37"
Cohesion: 0.08
Nodes (51): apifyReadiness, InstagramPost, addAudienceMembers(), createAudience(), NewMember, saveMemberInsights(), summarizeAudience(), createInstagramContactsAudience() (+43 more)

### Community 38 - "Community 38"
Cohesion: 0.07
Nodes (32): APOLLO, ACTION_CATEGORIES, compatibleColumns(), CLEANLIST_HANDLERS, CLEANLIST, CONTACTOUT, FINDYMAIL, FULLENRICH (+24 more)

### Community 39 - "Community 39"
Cohesion: 0.09
Nodes (46): Ctx, POST(), Ctx, DELETE(), PATCH(), GET(), POST(), GET() (+38 more)

### Community 40 - "Community 40"
Cohesion: 0.07
Nodes (44): dynamic, GET(), failure(), GET(), PUT(), dynamic, dynamic, InquiriesSettingsPage() (+36 more)

### Community 41 - "Community 41"
Cohesion: 0.06
Nodes (46): Campaign, CampaignDetailClient(), createdLabel(), LinkedInAccount, sequenceStepsBuilt(), TabId, ChartDay, EditableCampaign (+38 more)

### Community 42 - "Community 42"
Cohesion: 0.08
Nodes (44): dynamic, GET(), GET(), ConnectionsPage(), dynamic, initialsOf(), Props, timeAgo() (+36 more)

### Community 43 - "Community 43"
Cohesion: 0.07
Nodes (40): Answer, decode(), DECODED_ENCODINGS, decodedBody(), fetchAnswer(), fetchPublicPage(), notPublic(), PageFetchOptions (+32 more)

### Community 44 - "Community 44"
Cohesion: 0.05
Nodes (34): STATEMENTS, TABLES, STATEMENTS, EXPECTED_TABLES, TABLES, WIDENED, STATEMENTS, STATEMENTS (+26 more)

### Community 45 - "Community 45"
Cohesion: 0.07
Nodes (41): Ctx, dynamic, POST(), answerDecision(), DecisionError, getDecision(), resolveDecision(), instagramCapabilityProblem() (+33 more)

### Community 46 - "Community 46"
Cohesion: 0.09
Nodes (42): POST(), findInstagramAccountByUnipileId(), markInstagramAccountUnusable(), deliverInstagramFromCrm(), DeliverInstagramInput, DeliverInstagramResult, INSTAGRAM_MAX_MESSAGE_LENGTH, InstagramDeliveryError (+34 more)

### Community 47 - "Community 47"
Cohesion: 0.06
Nodes (40): CallingLayout(), dynamic, metadata, dynamic, InstagramLayout(), metadata, dynamic, LinkedInLayout() (+32 more)

### Community 48 - "Community 48"
Cohesion: 0.07
Nodes (43): dynamic, GridIndexPage(), GridLoader(), WorkbookClient, MoveTableDialog(), renderBranch(), toggle(), WorkbookRow (+35 more)

### Community 49 - "Community 49"
Cohesion: 0.10
Nodes (40): POST(), GET(), POST(), GET(), applyCallResultToContactSafely(), assertRecordingKeyMatches(), assertUploadAllowed(), authorizeRecorder() (+32 more)

### Community 50 - "Community 50"
Cohesion: 0.10
Nodes (47): DELETE(), PATCH(), GET(), create(), GET(), list(), POST(), columnErrorResponse() (+39 more)

### Community 51 - "Community 51"
Cohesion: 0.07
Nodes (47): GET(), GET(), GET(), hasConnectedWhatsappAccount(), BackfillWhatsappAccountResponse, ListWhatsappChatsResponse, PersonWhatsappThreadResponse, SendWhatsappRequest (+39 more)

### Community 52 - "Community 52"
Cohesion: 0.10
Nodes (48): chatTitle(), clickChatLink(), closeContactForm(), commonAncestor(), confirmedTitles, describeButtons(), dial(), elementWithText() (+40 more)

### Community 53 - "Community 53"
Cohesion: 0.08
Nodes (35): GET(), POST(), AIML_KEYS_URL, AIML_PROVIDER_KEY, AIML_PROVIDER_NAME, AI_PROVIDERS, getAiModel(), getAiProvider() (+27 more)

### Community 54 - "Community 54"
Cohesion: 0.08
Nodes (40): AppIcon(), Logo(), useDemoMode(), CommandPalette(), change(), go(), activeHref(), allLinks() (+32 more)

### Community 55 - "Community 55"
Cohesion: 0.09
Nodes (42): completeStructured(), StructuredCompletionRuntime, input, Reply, LeadApproach, FIRST_MESSAGE_LIMITS, firstWord(), lineClash() (+34 more)

### Community 56 - "Community 56"
Cohesion: 0.11
Nodes (41): hash(), identitiesFromLeadData(), main(), APPLY, assertSchemaPrepared(), canonicalLinkedinFromLegacy(), duplicatePlannedMemberships(), emailFromLegacy() (+33 more)

### Community 57 - "Community 57"
Cohesion: 0.09
Nodes (41): dynamic, GET(), dynamic, metadata, ResultsPage(), CHANNEL, Item(), act() (+33 more)

### Community 58 - "Community 58"
Cohesion: 0.10
Nodes (41): CrmSendAdapterInput, findWhatsappAccountByUnipileId(), getDefaultWhatsappAccountRow(), getWhatsappAccountRow(), refused(), deliverWhatsappFromCrm(), DeliverWhatsappInput, DeliverWhatsappResult (+33 more)

### Community 59 - "Community 59"
Cohesion: 0.05
Nodes (25): dist, files, filesUnder(), out, zippable, db, TERMINAL, DB_DIR (+17 more)

### Community 60 - "Community 60"
Cohesion: 0.07
Nodes (43): AI_INSTRUCTIONS, CITY_FOR_COUNTRY, COMPANIES, COMPANY_ROWS, companyDomain(), CompanySeed, FEMALE_FIRST, Industry (+35 more)

### Community 61 - "Community 61"
Cohesion: 0.10
Nodes (37): main(), POST(), POST(), POST(), handle(), isStringArray(), POST(), POST() (+29 more)

### Community 62 - "Community 62"
Cohesion: 0.07
Nodes (41): Ctx, dynamic, GET(), getAudience(), memberInsights(), businessContext, BusinessSources, looksLikeSenderName() (+33 more)

### Community 63 - "Community 63"
Cohesion: 0.11
Nodes (41): GET(), dynamic, WorkbookPage(), GRID_PAGE_SIZE, assertKnownColumns(), boundValue(), buildOrderBy(), buildWhere() (+33 more)

### Community 64 - "Community 64"
Cohesion: 0.09
Nodes (41): dynamic, errorResponse(), GET(), maxDuration, Params, POST(), assistantUsage, UsageKind (+33 more)

### Community 65 - "Community 65"
Cohesion: 0.10
Nodes (42): ClaimResult, claimSlot(), finishSlot(), isMissingTable(), lastStarts(), pruneClaims(), warnMissingTable(), OrganizationDay (+34 more)

### Community 66 - "Community 66"
Cohesion: 0.07
Nodes (41): AccountPool, claimAccount(), concurrencyFor(), excludeList(), getStatus(), mapResults(), processQuery(), randomInt() (+33 more)

### Community 67 - "Community 67"
Cohesion: 0.07
Nodes (41): replyText(), atBiz(), Beat, CAMPAIGN_A_STEPS, CAMPAIGN_B_STEPS, ChatPlan, digitsOf(), fillCall() (+33 more)

### Community 68 - "Community 68"
Cohesion: 0.15
Nodes (24): AcceptInvitationPage(), Invitation, ForgotPasswordPage(), OnboardingPage(), ResetPasswordPage(), ResetPasswordForm(), SetupForm(), accessRequestHref() (+16 more)

### Community 69 - "Community 69"
Cohesion: 0.10
Nodes (39): DELETE(), isStringArray(), POST(), DELETE(), isUrlRows(), POST(), DELETE(), GET() (+31 more)

### Community 70 - "Community 70"
Cohesion: 0.10
Nodes (38): GET(), GET(), GET(), POST(), GET(), GET(), POST(), GET() (+30 more)

### Community 71 - "Community 71"
Cohesion: 0.09
Nodes (29): HEADERS, POST(), cell(), EmailCsvMapping, importLeadsForCampaign(), ImportResult, MAX_IMPORT_ROWS, normalizeHeader() (+21 more)

### Community 72 - "Community 72"
Cohesion: 0.08
Nodes (30): dynamic, importPeople(), POST(), Channel, CHANNEL_NAME, FIELDS, Operation, Preview (+22 more)

### Community 73 - "Community 73"
Cohesion: 0.10
Nodes (34): GET(), CONTACT_CALL_STATUS_DEFINITIONS, CONTACT_CALL_STATUSES, ContactCallStatus, addGroup(), CallGroup, CallOutcome, Counts (+26 more)

### Community 74 - "Community 74"
Cohesion: 0.06
Nodes (28): dynamic, dynamic, dynamic, dynamic, dynamic, dynamic, AiSettingsPage(), dynamic (+20 more)

### Community 75 - "Community 75"
Cohesion: 0.11
Nodes (34): GET(), GET(), PUT(), saveAimlSettings(), empty, getByokSettings(), saveByokSettings(), getAiConnection() (+26 more)

### Community 76 - "Community 76"
Cohesion: 0.09
Nodes (36): failure(), GET(), PUT(), AccountLimits, ApifySettingsError, apifySettingsView(), bounded(), finishRow() (+28 more)

### Community 77 - "Community 77"
Cohesion: 0.11
Nodes (37): Ctx, failure(), GET(), PUT(), Channel, CHANNEL_RULES, ChannelRuleValues, CHANNELS (+29 more)

### Community 78 - "Community 78"
Cohesion: 0.08
Nodes (26): metadata, NewCampaignPage(), DEFAULT_FIELDS, MergeField, MergeFieldChips(), Preview, PreviewLead, PreviewMailbox (+18 more)

### Community 79 - "Community 79"
Cohesion: 0.07
Nodes (36): accounts, ALL_DAY, gmailAccount, outlookAccount, Recorded, requests, runId, stamp (+28 more)

### Community 80 - "Community 80"
Cohesion: 0.09
Nodes (34): dynamic, GET(), publicOrigin(), SignInPage(), SignUpPage(), safeFrom(), GOOGLE_SIGN_IN_ENABLED, publicSignupAvailable() (+26 more)

### Community 81 - "Community 81"
Cohesion: 0.12
Nodes (31): diagnoseDelivery(), emailSendingStatus(), mailboxDailyRoom(), MailboxSnapshot, input, mailbox, now, WeeklyHours (+23 more)

### Community 82 - "Community 82"
Cohesion: 0.11
Nodes (17): Arrow(), clamp(), compile(), computeRect(), DEFAULTS, EngineOptions, hexToRgb(), injectFonts() (+9 more)

### Community 83 - "Community 83"
Cohesion: 0.12
Nodes (35): asAddressList(), dedupeAddresses(), EmailAddress, isValidEmail(), MAX_REPLY_EXTRA_RECIPIENTS, MessageRecipients, normalizeEmail(), replyAllCc() (+27 more)

### Community 84 - "Community 84"
Cohesion: 0.11
Nodes (36): callDocuments(), CallUi, clockSeconds(), Connect, describe(), Disconnect, findEndButtonIn(), findStatusText() (+28 more)

### Community 85 - "Community 85"
Cohesion: 0.12
Nodes (36): list(), dynamic, LeadsPage(), metadata, findOrCreateContactPerson(), factsOf(), matchReasonOf(), savePlace() (+28 more)

### Community 86 - "Community 86"
Cohesion: 0.10
Nodes (27): createPerson(), GET(), listPeople(), POST(), cancelQueries(), linkedinPeopleSearchUrl(), linkedinSearchAvailability(), Payload (+19 more)

### Community 87 - "Community 87"
Cohesion: 0.11
Nodes (34): POST(), hoursSummary(), resolveProfiles(), syncAllAccounts(), syncOrganizationAccounts(), runOrganizationOutreach(), RunOutreachOptions, computeNextAllowedRun() (+26 more)

### Community 88 - "Community 88"
Cohesion: 0.11
Nodes (37): aiReadiness(), buildReadiness(), campaignsReadiness(), CHANNEL_LABEL, day(), emailReadiness(), forRole(), GmailWatchFacts (+29 more)

### Community 89 - "Community 89"
Cohesion: 0.08
Nodes (27): cookie(), signIn(), stamp, GET, POST, authEmail, escapeHtml(), sendAuthEmail() (+19 more)

### Community 90 - "Community 90"
Cohesion: 0.11
Nodes (33): assert(), body, main(), values, authorized(), handle(), POST(), text() (+25 more)

### Community 91 - "Community 91"
Cohesion: 0.06
Nodes (26): automationDone, MAPS_CSV, PAGES, pune, ScraperJob, scraperJobs, stamp, unipileSends (+18 more)

### Community 92 - "Community 92"
Cohesion: 0.09
Nodes (28): AiConnection, setupSnapshot(), startWebDiscovery(), WebDiscoveryLimitError, WebDiscoveryUnavailableError, loadRuntime(), openRouterSearchRequest(), searchWeb() (+20 more)

### Community 93 - "Community 93"
Cohesion: 0.14
Nodes (32): runAnthropic(), callGemini(), GeminiPart, GeminiResponse, runGoogle(), runGoogleImage(), asPermanent(), client() (+24 more)

### Community 94 - "Community 94"
Cohesion: 0.10
Nodes (34): AcceptedDraftClassification, buildDraftPrompt(), BuiltDraftPrompt, cleanOptionalText(), cleanRequiredText(), completedActionsFor(), completeDraftWithOpenRouter(), CrmDraftContent (+26 more)

### Community 95 - "Community 95"
Cohesion: 0.12
Nodes (33): SetLeadStageRequest, callFollowUpUpdate(), FollowUpRecordState, FollowUpRecordUpdate, syncCallFollowUp(), syncCallFollowUpSafely(), DUE, idle (+25 more)

### Community 96 - "Community 96"
Cohesion: 0.11
Nodes (31): asObject(), Attendee, date(), decideIngest(), ECHO_MATCH_WINDOW_MS, flag(), IngestDecision, Json (+23 more)

### Community 97 - "Community 97"
Cohesion: 0.12
Nodes (31): POST(), normalizeLinkedinApiHint(), LeadMutationContext, buildFailedLeadsExcelBuffer(), FAILED_REASON_COLUMN, FailedLeadExportRow, failedLeadsFilePayload(), mappedLeadRowToRaw() (+23 more)

### Community 98 - "Community 98"
Cohesion: 0.11
Nodes (31): AccountRow, ALTS, CampaignPlan, chatIdFor(), daysAgoFrac(), insertChunks(), inWindow(), leadFollowUps (+23 more)

### Community 99 - "Community 99"
Cohesion: 0.15
Nodes (24): POST(), PATCH(), GET(), POST(), POST(), GET(), GET(), requireFeature() (+16 more)

### Community 100 - "Community 100"
Cohesion: 0.12
Nodes (31): addPeopleToWhatsappCampaign(), assertUuidShape(), campaignLeadInOrg(), escapeLike(), hydrateLeads(), importWhatsappCampaignLeads(), leadSelect(), listWhatsappCampaignLeads() (+23 more)

### Community 101 - "Community 101"
Cohesion: 0.11
Nodes (17): verifyApolloCredentials(), REQUIRED_SCOPES, verifyCleanlistCredentials(), verifyContactOutCredentials(), verifyFindymailCredentials(), verifyFullEnrichCredentials(), verifyHunterCredentials(), verifyIcypeasCredentials() (+9 more)

### Community 102 - "Community 102"
Cohesion: 0.12
Nodes (27): LegacyProvider, main(), failure(), GET(), PUT(), getIntegrationCredential(), getIntegrationCredentials(), decryptCredentialText() (+19 more)

### Community 103 - "Community 103"
Cohesion: 0.10
Nodes (24): ComingSoonCard(), CopyValue(), formatVerified(), GmailWatchStatus(), IntegrationDialog(), PlatformCard(), PlatformConnection(), PlatformLogo() (+16 more)

### Community 104 - "Community 104"
Cohesion: 0.12
Nodes (31): AccountOutcome, deleteClaim(), failClaim(), handleSendFailure(), LeadRow, openLead(), pickDueLead(), processLead() (+23 more)

### Community 105 - "Community 105"
Cohesion: 0.12
Nodes (28): GET(), assertPersonInOrg(), bucketName(), extensionFor(), getRecordingBytes(), headRecording(), PHOTO_EXTENSIONS, PHOTO_FILE_PATTERN (+20 more)

### Community 106 - "Community 106"
Cohesion: 0.12
Nodes (25): GET(), AIML_BASE_URL, AIML_MODELS_DOCS_URL, AimlCatalogEntry, AimlModelSummary, aimlStructuredMode(), selectableAimlModels(), ByokSettings (+17 more)

### Community 107 - "Community 107"
Cohesion: 0.10
Nodes (23): apply, dropIfInvalid(), main(), quote(), required(), contract, fail(), main() (+15 more)

### Community 108 - "Community 108"
Cohesion: 0.13
Nodes (30): addDays(), bucketFor(), bucketStarts(), change(), EmailAnalytics, LinkedinAnalytics, previousRange(), ratio() (+22 more)

### Community 109 - "Community 109"
Cohesion: 0.13
Nodes (29): availableTokens(), BASE_TOKENS, ensureSignOff(), escapeRegExp(), leadTextKey(), MAX_GROUPS, MAX_PERSONAL, perLeadSteps() (+21 more)

### Community 110 - "Community 110"
Cohesion: 0.11
Nodes (30): actionArgIndex, ActionResult, APOLLO_ORDER, apolloPrerequisites(), baseInputs(), extractApolloArtifacts(), inputIssues(), integrationArgIndex (+22 more)

### Community 111 - "Community 111"
Cohesion: 0.13
Nodes (28): Ctx, DELETE(), PUT(), Ctx, failure(), GET(), POST(), isPlatformKey() (+20 more)

### Community 112 - "Community 112"
Cohesion: 0.11
Nodes (25): fontSerif, metadata, RootLayout(), Loading(), AppShell(), CHROMELESS_ROUTES, isChromeless(), mayBounce() (+17 more)

### Community 113 - "Community 113"
Cohesion: 0.12
Nodes (23): POST(), run(), CampaignDomainRow, dynamic, runtime, stream(), listPendingCandidates(), selectCandidates() (+15 more)

### Community 114 - "Community 114"
Cohesion: 0.12
Nodes (21): GET(), POST(), Catalog(), ColumnMappingSelect(), EnrichmentDialog(), chooseAction(), removeFilter(), setInputColumn() (+13 more)

### Community 115 - "Community 115"
Cohesion: 0.14
Nodes (27): handle(), LogEntry, LogLevel, makeLogger(), POST(), WebhookBody, handle(), LogEntry (+19 more)

### Community 116 - "Community 116"
Cohesion: 0.07
Nodes (29): AudienceData, BusinessProfileSummary, CHANNEL_LABEL, ChannelStatus, COMPACT_TOOLS, ConversationMenu(), DECISION_LABEL, DecisionState (+21 more)

### Community 117 - "Community 117"
Cohesion: 0.12
Nodes (26): CampaignLead, CampaignLeadsTab(), CrossCampaignNotice, InitialLeadsPage, LeadAvatar(), LeadsPagination, LinkedInAccount, MESSAGE_FIELDS (+18 more)

### Community 118 - "Community 118"
Cohesion: 0.08
Nodes (20): accountA1, accountA2, accountA3, accountHook(), beforeSendAnswer, callRoute(), chatsByAccount, countA() (+12 more)

### Community 119 - "Community 119"
Cohesion: 0.10
Nodes (18): contentType, size, Home(), metadata, brandDisplay, brandDisplayClass, ICON_RADIUS, FAQ (+10 more)

### Community 120 - "Community 120"
Cohesion: 0.19
Nodes (26): startTrackedRun(), apifyAllowance, ApifyAllowanceInput, firstString(), hashtagsFor(), InstagramProfile, Json, looksExhausted() (+18 more)

### Community 121 - "Community 121"
Cohesion: 0.14
Nodes (23): LeadMessageTemplates, renderLeadTemplates(), appendUnsubscribeFooter(), applySignature(), escapeHtml(), fillTemplate(), RenderableLead, renderEmail() (+15 more)

### Community 122 - "Community 122"
Cohesion: 0.11
Nodes (23): AiCall, aiCalls, aimlAnswer(), blocked, checkOrganizations, citation(), createdMailboxes, createdProviders (+15 more)

### Community 123 - "Community 123"
Cohesion: 0.10
Nodes (18): dynamic, dynamic, dynamic, dynamic, dynamic, metadata, Page(), dynamic (+10 more)

### Community 124 - "Community 124"
Cohesion: 0.12
Nodes (24): Avatar(), DetailRow(), draftFromLead(), fmt(), LEAD_STATUS_LABELS, LEAD_STATUS_VARIANTS, LeadDetail, LeadDetailPanel() (+16 more)

### Community 125 - "Community 125"
Cohesion: 0.08
Nodes (25): action, default_icon, default_title, background, service_worker, type, content_scripts, 16 (+17 more)

### Community 126 - "Community 126"
Cohesion: 0.14
Nodes (23): AnalyticsPage(), dynamic, metadata, Search, AnalyticsClient(), Cached, DateRangeControl(), LoadingBlock() (+15 more)

### Community 127 - "Community 127"
Cohesion: 0.14
Nodes (20): PATCH(), queueDependents(), dynamic, ExportRequest, filenameFor(), POST(), validateStringList(), changedCellUpdates() (+12 more)

### Community 128 - "Community 128"
Cohesion: 0.13
Nodes (24): AudienceSummary, EXISTING_LEADS_FROM, ExistingLeadsFrom, inquiryFacts(), InquiryLike, inquirySignal(), isExistingLeadsFrom(), matchReasonForExisting() (+16 more)

### Community 129 - "Community 129"
Cohesion: 0.15
Nodes (18): asCountryCode(), checkPhone(), normalizePhone(), PhoneCheck, whatsappDigits(), emailMatchesDomain(), placeEvidence(), addressParts() (+10 more)

### Community 130 - "Community 130"
Cohesion: 0.13
Nodes (19): POST(), register(), BLOCKED_MUTATION_PREFIXES, CONTROL_ENV, enabled(), Environment, isMigrationControlPaused(), isPeopleMigrationMode() (+11 more)

### Community 131 - "Community 131"
Cohesion: 0.14
Nodes (22): ANALYTICS_CHANNELS, AnalyticsChannel, AnalyticsRange, AnalyticsResponseFor, BreakdownRow, CrmCategory, CrmSummary, FunnelStageKey (+14 more)

### Community 132 - "Community 132"
Cohesion: 0.15
Nodes (22): RFC-5321, cleanLinkedinUrl(), contactPageLinks(), decodeEntities(), DOT_TOKEN, DOT_TOKEN_GLOBAL, extractContacts(), FoundContact (+14 more)

### Community 133 - "Community 133"
Cohesion: 0.16
Nodes (23): authPost(), cookiesFrom(), fill(), Finding, fingerprintsOfA(), FIXED_PARAMS, foreignKeyColumn(), leaksIn() (+15 more)

### Community 134 - "Community 134"
Cohesion: 0.13
Nodes (21): resolveScriptOrganization(), assertCore(), DatabaseError, errorCode(), EXPECTED_TABLES, expectRejected(), main(), runWithSavepoint() (+13 more)

### Community 135 - "Community 135"
Cohesion: 0.15
Nodes (17): POST(), create(), onName(), dynamic, SetupPage(), submit(), createInitialAdmin(), needsSetup() (+9 more)

### Community 136 - "Community 136"
Cohesion: 0.13
Nodes (21): LinkedInAccountRef, LinkedInAccountTag(), SIZE, TagAvatar(), SenderAccount, SenderAccountAvatar(), Account, Connection (+13 more)

### Community 137 - "Community 137"
Cohesion: 0.13
Nodes (20): HANDOVER_INTERVAL_MS, handoverMessage(), isHandoff(), LABELS, messageLanguage(), NO_ANSWER_NEEDED, REMINDER_AFTER_MS, REPORT_KINDS (+12 more)

### Community 138 - "Community 138"
Cohesion: 0.13
Nodes (23): compareCandidates(), DEFAULT_KNOWLEDGE_TOKENS, estimateKnowledgeTokens(), hashExcerpt, hashKnowledgeExcerpt(), KNOWLEDGE_CHARS_PER_TOKEN, KnowledgeCandidate, KnowledgeCitation (+15 more)

### Community 139 - "Community 139"
Cohesion: 0.19
Nodes (18): create(), POST(), APOLLO_LINK_PARAMS, buildApolloPeopleSearchUrl(), addManualCandidates(), assembleApolloLink(), baseCampaignName(), cleanNamePart() (+10 more)

### Community 140 - "Community 140"
Cohesion: 0.15
Nodes (19): GET(), defaultLockKey(), ensureDefaultAccount(), listWhatsappAccounts(), setDefaultWhatsappAccount(), setWhatsappNewChatsPerDay(), syncWhatsappAccounts(), toWhatsappAccountSummary() (+11 more)

### Community 141 - "Community 141"
Cohesion: 0.16
Nodes (17): SettingsModalLayout(), metadata, SettingsLayout(), itemPages(), SETTINGS_HOME, SettingsNavItem, SettingsTab, visibleSettingsNav() (+9 more)

### Community 142 - "Community 142"
Cohesion: 0.11
Nodes (16): EnrichmentSession, ColumnRunner, RunContext, RunSession, CellStatus, CurrencyConfig, IntegrationInputBinding, PendingCellResult (+8 more)

### Community 143 - "Community 143"
Cohesion: 0.15
Nodes (17): publicAppUrl(), HOSTED_AUTH_NOTIFY_PATH, HOSTED_AUTH_RETURN_PATH, original, isReplaceable(), ListedWebhook, listWebhooks(), registerUnipileWebhooks() (+9 more)

### Community 144 - "Community 144"
Cohesion: 0.19
Nodes (19): DbRow, hash(), main(), REPORT, action(), classifyWebhookOwnership(), compareEligibleAccountIds(), compareLinkedinLead() (+11 more)

### Community 145 - "Community 145"
Cohesion: 0.10
Nodes (15): dynamic, dynamic, dynamic, dynamic, metadata, Page(), dynamic, metadata (+7 more)

### Community 146 - "Community 146"
Cohesion: 0.13
Nodes (16): ActiveJobInfo, CampaignDetailClient(), CampaignInfo, DebugSidePanel(), DomainRow, formatRevenue(), formatTimestamp(), JsonBlock() (+8 more)

### Community 147 - "Community 147"
Cohesion: 0.14
Nodes (16): RFC-2822, buildRawEmailMessage(), extractBodyText(), fetchMessageRecipients(), fetchNewInboundMessages(), isStaleHistoryCursorError(), jwtFor(), MailboxConnectionTest (+8 more)

### Community 148 - "Community 148"
Cohesion: 0.15
Nodes (17): apply, env(), FROM_ENV, main(), migratePlatform(), migrateTranscriptionModel(), overwrite, dynamic (+9 more)

### Community 149 - "Community 149"
Cohesion: 0.18
Nodes (17): authorized(), handle(), organizationOfAccount(), POST(), text(), POST(), INSTAGRAM_WEBHOOK_REPLAY_SCOPE, InstagramReplaySummary (+9 more)

### Community 150 - "Community 150"
Cohesion: 0.23
Nodes (20): BuiltClassificationContext, ClassificationCampaignSummary, ClassificationContextSnapshot, ClassificationMessage, boundedText(), buildClassificationContext(), campaignSnapshot(), cleanText() (+12 more)

### Community 151 - "Community 151"
Cohesion: 0.14
Nodes (12): canonicalFromLeadData(), Classification, classifyLinkedinIdentifier(), main(), Candidate, candidates(), integerArgument(), main() (+4 more)

### Community 152 - "Community 152"
Cohesion: 0.16
Nodes (19): ActivityRow(), Card(), DecisionCard(), act(), DiscoveryCard(), InquiryRunCard(), act(), LeadsList() (+11 more)

### Community 153 - "Community 153"
Cohesion: 0.18
Nodes (17): setParentDomain(), normalizeDomainForTargeting(), BROWSER_HEADERS, buildCandidateUrls(), checkLiveness(), DEAD_STORE_PATTERNS, LivenessResult, apolloReason() (+9 more)

### Community 154 - "Community 154"
Cohesion: 0.15
Nodes (17): WhatsappAnalytics, WhatsappCallOutcome, localDay(), runLimited(), CallRow, CampaignCallRow, CLASS_ERROR, ERROR_CLASS (+9 more)

### Community 155 - "Community 155"
Cohesion: 0.15
Nodes (14): activeTaxonomy(), CATEGORY_KEYS, classificationChannelNotes(), classifierJsonSchema(), completeClassificationWithOpenRouter(), isPlainObject(), OUTPUT_KEYS, parseStrictJson() (+6 more)

### Community 156 - "Community 156"
Cohesion: 0.13
Nodes (11): inbound, outbound, CATEGORY, leadProgress, LeadProgressInput, replied(), base, input (+3 more)

### Community 157 - "Community 157"
Cohesion: 0.18
Nodes (11): Button, ButtonProps, buttonVariants, Dialog, DialogClose, DialogContent(), DialogHeader(), DialogOverlay() (+3 more)

### Community 158 - "Community 158"
Cohesion: 0.12
Nodes (11): apify, AssistantJob, context, createdProviders, mapsItems, RunScript, runToEnd(), scraperJobs (+3 more)

### Community 159 - "Community 159"
Cohesion: 0.20
Nodes (15): csvEscape(), dynamic, exportCampaigns(), GET(), csvEscape(), dynamic, exportCampaign(), GET() (+7 more)

### Community 160 - "Community 160"
Cohesion: 0.19
Nodes (14): RFC-7505, clearMailDomainCache(), definitelyNone(), domainCache, DomainCheck, emailDomainCheck(), hasAddressRecord(), MailDns (+6 more)

### Community 161 - "Community 161"
Cohesion: 0.31
Nodes (14): refreshBridges(), syncCustomBridges(), addOrigin(), removeOrigin(), render(), row(), setStatus(), allowedOrigins() (+6 more)

### Community 162 - "Community 162"
Cohesion: 0.15
Nodes (14): GET(), csvEscape(), GET(), dynamic, GET(), ZIP_PATH, AuthContextError, getOrgContext() (+6 more)

### Community 163 - "Community 163"
Cohesion: 0.26
Nodes (15): ActivitySlot, applyOutboundMessage(), emptySlot(), GET(), tallyOutboundTotals(), MessageType, addCalendarDays(), CalendarDate (+7 more)

### Community 164 - "Community 164"
Cohesion: 0.23
Nodes (13): DELETE(), GET(), POST(), POST(), GET(), POST(), connectMailbox(), ConnectMailboxResult (+5 more)

### Community 165 - "Community 165"
Cohesion: 0.18
Nodes (13): LEAD_STAGE_CATEGORIES, LeadStageCategory, DO_NOT_CONTACT_SUBCATEGORY_KEY, ClassificationCategory, ClassificationCompanyProfile, ClassificationContextInput, ClassificationKnowledgeDocument, ClassificationPersonProfile (+5 more)

### Community 166 - "Community 166"
Cohesion: 0.26
Nodes (15): chooseFolder(), download(), FolderHandle, notThisExtension(), openStore(), PermissionMode, render(), running (+7 more)

### Community 167 - "Community 167"
Cohesion: 0.14
Nodes (7): deliver(), janeBody, json(), manage(), person(), Reply, stamp

### Community 168 - "Community 168"
Cohesion: 0.23
Nodes (12): DELETE(), PATCH(), GET(), POST(), DELETE(), PATCH(), createNote(), deleteNote() (+4 more)

### Community 169 - "Community 169"
Cohesion: 0.14
Nodes (11): AssistantPage(), dynamic, metadata, AssistantAvatar(), AssistantClient(), pickStarter(), send(), AssistantStatePayload (+3 more)

### Community 170 - "Community 170"
Cohesion: 0.24
Nodes (8): CallingMessagesLoading(), InstagramMessagesLoading(), MessagesLoading(), InboxLoading(), NotesLoading(), TasksLoading(), InboxRouteSkeleton(), MessagesLoadingSkeleton()

### Community 171 - "Community 171"
Cohesion: 0.21
Nodes (12): dynamic, Accounts(), dynamic, LinkedInAccountsPage(), metadata, ConnectAccountButton(), HostedAuthReturn(), startHostedAuth() (+4 more)

### Community 172 - "Community 172"
Cohesion: 0.17
Nodes (12): AiDialog(), setOutput(), caretRect(), fieldKey(), OpenRouterChoice, OUTPUT_TYPES, Section(), AiModelChoice (+4 more)

### Community 173 - "Community 173"
Cohesion: 0.26
Nodes (15): CellDetailsPanel(), CellDetailsSelection, CellRun, copyValue(), DetailsResponse, displayValue(), escapePointer(), flattenJson() (+7 more)

### Community 174 - "Community 174"
Cohesion: 0.18
Nodes (13): LINKEDIN_FIELDS, normalize(), PERSON_FIELDS, suggestedMapping(), CHANNEL_TEMPLATE_FIELDS, CreateGridCampaignInput, GridCampaignChannel, GridCampaignFailure (+5 more)

### Community 175 - "Community 175"
Cohesion: 0.25
Nodes (11): strictImageProviderRouting(), errorStatus(), isTransientOpenRouterError(), generateOpenRouterImage(), auditError(), chatRunner(), runOpenRouterImage(), upstreamMessage() (+3 more)

### Community 176 - "Community 176"
Cohesion: 0.33
Nodes (15): collectSignals(), COMPANY_SIGNAL_TYPES, errorText(), executeCompanySignal(), executeEnrichCompany(), executeEnrichPerson(), executePersonSignals(), finish() (+7 more)

### Community 177 - "Community 177"
Cohesion: 0.26
Nodes (14): apolloSearchWithDebug(), appendDomainParams(), countAllPeople(), countLeads(), countLeadsWithDebug(), countVerifiedPeople(), normalizeDomains(), paramsToRecord() (+6 more)

### Community 178 - "Community 178"
Cohesion: 0.24
Nodes (12): first(), getInstagramPost(), getInstagramProfile(), InstagramCommentRead, instagramCommentsFrom(), instagramPostFrom(), InstagramPostRead, instagramProfileFrom() (+4 more)

### Community 179 - "Community 179"
Cohesion: 0.26
Nodes (15): ByokSettingsClient(), connectAccount(), loadCatalog(), refreshDiscovery(), save(), setDefaultModel(), setTranscriptionModel(), switchConnection() (+7 more)

### Community 180 - "Community 180"
Cohesion: 0.19
Nodes (13): answerText(), attempt(), buildRequest(), describeResponseError(), isJsonObjectText(), isStrictJsonSchema(), jsonSchemaSystemPrompt(), RejectedAttemptError (+5 more)

### Community 181 - "Community 181"
Cohesion: 0.21
Nodes (10): contactChannels(), ContactFacts, countReasons(), definiteInstagramRefusal(), deliverInitialInstagramDm(), InitialDm, InitialDmEffects, job (+2 more)

### Community 182 - "Community 182"
Cohesion: 0.19
Nodes (13): AUTOPILOT_ESCALATE_SUBCATEGORIES, AUTOPILOT_LIMITS, AutopilotFacts, autopilotGate, CONFIRMED_CLASSIFICATIONS, decide(), GateDecisionKind, hold() (+5 more)

### Community 183 - "Community 183"
Cohesion: 0.30
Nodes (14): normalizeDomain(), assertSnovResponse(), executeSnov(), extractSnovOutputs(), fetchJson(), getSnovAccessToken(), isSnovProfileNotFound(), makeSnovResult() (+6 more)

### Community 184 - "Community 184"
Cohesion: 0.20
Nodes (7): escapeHtml(), Recipient, RecipientChips(), ReplyComposer(), ReplyComposerProps, textToHtml(), ToolbarButton()

### Community 185 - "Community 185"
Cohesion: 0.13
Nodes (10): { Client }, COUNTRIES, envContent, fs, path, { Client }, envContent, envPath (+2 more)

### Community 186 - "Community 186"
Cohesion: 0.20
Nodes (10): dynamic, GET(), LOADERS, AnalyticsResponse, MAX_ANALYTICS_RANGE_DAYS, WEEKLY_BUCKET_AFTER_DAYS, AnalyticsRangeError, createLimiter() (+2 more)

### Community 187 - "Community 187"
Cohesion: 0.22
Nodes (10): DomainsTable(), fmt(), PageBtn(), Props, ExportModal(), NavContext, NavCtx, useNavigation() (+2 more)

### Community 188 - "Community 188"
Cohesion: 0.18
Nodes (6): configuredSocialAdapters(), MetaGraphCredentials, metaGraphHashtagAdapter(), normalizeHashtag(), SocialKeywordAdapter, SocialMediaItem

### Community 189 - "Community 189"
Cohesion: 0.19
Nodes (9): COUNTRY_OPTIONS, CreateCampaignForm(), Label(), MODE_OPTIONS, PLATFORM_OPTIONS, TARGET_MODE_OPTIONS, Props, Select() (+1 more)

### Community 190 - "Community 190"
Cohesion: 0.32
Nodes (12): ApolloRequest, buildApolloRequest(), compactRecord(), contactFields(), contactOutput(), executeApollo(), extractApolloOutputs(), hasApolloResult() (+4 more)

### Community 191 - "Community 191"
Cohesion: 0.24
Nodes (9): InboxCrmConversation, InboxSendConnection, InboxSendDependencies, InboxSendError, InboxSentMessage, sendFromLinkedinInbox(), connection, crmConversation (+1 more)

### Community 192 - "Community 192"
Cohesion: 0.19
Nodes (10): AdsCheckInput, AdsCheckResult, AdsProvider, checkAds(), getAdsProvider(), httpAdsProvider(), mockAdsProvider, env (+2 more)

### Community 193 - "Community 193"
Cohesion: 0.30
Nodes (8): PlatformCredentials, googleServiceAccount(), GoogleServiceAccountKey, r2Client(), verifyGoogle(), verifyPlatformCredentials(), verifyR2(), verifyUnipile()

### Community 194 - "Community 194"
Cohesion: 0.23
Nodes (9): AuditRow, AUTOMATED_TYPES, AutomatedMessageType, main(), Recommendation, recommendSurvivor(), redact(), RedactedMessage (+1 more)

### Community 195 - "Community 195"
Cohesion: 0.33
Nodes (9): compareEmailParityRow(), legacyEmailVariables(), main(), ParityRow, pendingSteps(), SequenceStep, substituteVariables(), base (+1 more)

### Community 196 - "Community 196"
Cohesion: 0.36
Nodes (10): appSha(), arg(), Cursor, expectedInteger(), main(), parseCursor(), required(), safeRunId() (+2 more)

### Community 197 - "Community 197"
Cohesion: 0.29
Nodes (8): buildDecisions(), confirmationArgument(), decideDuplicateGroup(), DuplicateDecision, loadDuplicateRows(), main(), MessageRow, numericArgument()

### Community 198 - "Community 198"
Cohesion: 0.31
Nodes (10): APPLY, CredentialObject, CredentialRow, decrypt(), derivedKey(), encrypt(), fingerprint(), main() (+2 more)

### Community 199 - "Community 199"
Cohesion: 0.36
Nodes (10): handle(), HANDLED_STATUSES, POST(), resolveOrganization(), applyInstagramAccountOwner(), organizationIdForNotifySecret(), safeEqual(), unipileNotifySecret() (+2 more)

### Community 200 - "Community 200"
Cohesion: 0.33
Nodes (11): newStep(), stepLabel(), WhatsappSequenceEditor(), addFollowUp(), change(), insertToken(), move(), remove() (+3 more)

### Community 201 - "Community 201"
Cohesion: 0.38
Nodes (9): appSha(), arg(), Counts, expectedInteger(), inspect(), main(), Phase, required() (+1 more)

### Community 202 - "Community 202"
Cohesion: 0.36
Nodes (9): asRecords(), execute(), firstRecord(), pendingStatus(), personParams(), requestRocketReach(), ROCKETREACH_HANDLERS, runRocketReach() (+1 more)

### Community 203 - "Community 203"
Cohesion: 0.31
Nodes (7): capitalize(), DOMAINS, file, main(), Result, signatureFor(), TARGETS

### Community 204 - "Community 204"
Cohesion: 0.36
Nodes (7): DomainsPage(), getQueryParams(), Params, SearchParams, TableSection(), NavigationProvider(), TableSkeleton()

### Community 205 - "Community 205"
Cohesion: 0.28
Nodes (7): CategoryFilter(), CategorySelect(), CountMap, fmt(), NULL_CATEGORY, Props, SelectProps

### Community 206 - "Community 206"
Cohesion: 0.28
Nodes (8): COUNTRY_OPTIONS, DIR_OPTIONS, Filters(), Label(), PAGE_SIZE_OPTIONS, PLATFORM_OPTIONS, Section(), SORT_OPTIONS

### Community 207 - "Community 207"
Cohesion: 0.36
Nodes (6): FilterSelect(), FilterSelectOption, FilterSelectProps, limitRingClass(), OptionAvatar(), getSearchRemainingTier()

### Community 208 - "Community 208"
Cohesion: 0.29
Nodes (5): aiSource, Row, say(), shown(), stamp

### Community 209 - "Community 209"
Cohesion: 0.32
Nodes (5): call(), cookiesFrom(), privileged, signIn(), sql

### Community 210 - "Community 210"
Cohesion: 0.36
Nodes (7): assertPrepared(), Blocker, BLOCKER_QUERIES, findBlockers(), findInvalidIndexes(), main(), UNIQUE_INDEXES

### Community 211 - "Community 211"
Cohesion: 0.32
Nodes (5): CampaignsPage(), dynamic, CampaignListClient(), StatusBadge(), listCampaigns()

### Community 212 - "Community 212"
Cohesion: 0.29
Nodes (4): ALL_APPS, AppFilter(), fmt(), Props

### Community 213 - "Community 213"
Cohesion: 0.33
Nodes (6): envPath, fs, main(), path, postgres, sql

### Community 214 - "Community 214"
Cohesion: 0.33
Nodes (6): { Client }, envPath, fs, main(), normalizeDomain(), path

### Community 215 - "Community 215"
Cohesion: 0.33
Nodes (6): envPath, fs, main(), path, postgres, sql

### Community 216 - "Community 216"
Cohesion: 0.43
Nodes (6): execute(), parseDelimited(), Report, reportFor(), runSemrush(), SEMRUSH_HANDLERS

### Community 217 - "Community 217"
Cohesion: 0.47
Nodes (3): dynamic, UnsubscribePage(), UnsubscribeClient()

### Community 218 - "Community 218"
Cohesion: 0.60
Nodes (3): GET(), buildLeadsTemplateBuffer(), TEMPLATE_SAMPLE_ROW

### Community 219 - "Community 219"
Cohesion: 0.60
Nodes (3): GET(), buildSearchQueueTemplateBuffer(), TEMPLATE_SAMPLE_ROW

### Community 220 - "Community 220"
Cohesion: 0.50
Nodes (4): GET(), VALID_SECTIONS, getScheduledEmails(), InboxSection

### Community 221 - "Community 221"
Cohesion: 0.60
Nodes (4): NewWorkbookDialog(), createBlank(), createFromFile(), createWorkbook()

### Community 229 - "Community 229"
Cohesion: 0.67
Nodes (3): AudienceSummary(), hostOf(), RichText()

## Knowledge Gaps
- **17 isolated node(s):** `RFC-8058`, `RFC-5322`, `RFC-5321`, `RFC-7505`, `RFC-4180` (+12 more)
  These have ≤1 connection - possible missing edges. (Counts symbols only; 2563 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **16 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `inOrg()` connect `Community 0` to `Community 1`, `Community 2`, `Community 8`, `Community 12`, `Community 13`, `Community 15`, `Community 17`, `Community 18`, `Community 19`, `Community 20`, `Community 21`, `Community 22`, `Community 23`, `Community 24`, `Community 26`, `Community 27`, `Community 29`, `Community 30`, `Community 31`, `Community 34`, `Community 36`, `Community 37`, `Community 39`, `Community 40`, `Community 42`, `Community 45`, `Community 46`, `Community 48`, `Community 49`, `Community 50`, `Community 51`, `Community 53`, `Community 56`, `Community 57`, `Community 58`, `Community 61`, `Community 62`, `Community 63`, `Community 64`, `Community 66`, `Community 69`, `Community 70`, `Community 71`, `Community 75`, `Community 76`, `Community 77`, `Community 79`, `Community 81`, `Community 85`, `Community 86`, `Community 87`, `Community 88`, `Community 90`, `Community 92`, `Community 95`, `Community 97`, `Community 99`, `Community 100`, `Community 102`, `Community 104`, `Community 105`, `Community 111`, `Community 113`, `Community 114`, `Community 115`, `Community 120`, `Community 128`, `Community 139`, `Community 140`, `Community 153`, `Community 159`, `Community 163`, `Community 164`, `Community 168`, `Community 171`, `Community 174`, `Community 199`, `Community 211`, `Community 220`?**
  _High betweenness centrality (0.089) - this node is a cross-community bridge._
- **What connects `RFC-8058`, `RFC-5322`, `RFC-5321` to the rest of the system?**
  _17 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Community 0` be split into smaller, more focused modules?**
  _Cohesion score 0.02050957429973097 - nodes in this community are weakly interconnected._
- **Why does `cn()` connect `Community 10` to `Community 3`, `Community 4`, `Community 5`, `Community 6`, `Community 7`, `Community 9`, `Community 11`, `Community 141`, `Community 14`, `Community 17`, `Community 148`, `Community 152`, `Community 36`, `Community 169`, `Community 170`, `Community 41`, `Community 42`, `Community 179`, `Community 54`, `Community 184`, `Community 57`, `Community 68`, `Community 200`, `Community 74`, `Community 78`, `Community 229`, `Community 103`, `Community 116`, `Community 117`, `Community 119`, `Community 126`?**
  _High betweenness centrality (0.054) - this node is a cross-community bridge._
- **Should `Community 1` be split into smaller, more focused modules?**
  _Cohesion score 0.03765461847389558 - nodes in this community are weakly interconnected._
- **Why does `db` connect `Community 0` to `Community 1`, `Community 2`, `Community 8`, `Community 12`, `Community 13`, `Community 15`, `Community 18`, `Community 19`, `Community 20`, `Community 21`, `Community 22`, `Community 23`, `Community 24`, `Community 26`, `Community 27`, `Community 29`, `Community 30`, `Community 31`, `Community 34`, `Community 35`, `Community 36`, `Community 37`, `Community 39`, `Community 40`, `Community 42`, `Community 45`, `Community 46`, `Community 48`, `Community 49`, `Community 50`, `Community 51`, `Community 53`, `Community 55`, `Community 56`, `Community 57`, `Community 58`, `Community 60`, `Community 61`, `Community 62`, `Community 63`, `Community 64`, `Community 65`, `Community 66`, `Community 67`, `Community 69`, `Community 70`, `Community 71`, `Community 73`, `Community 75`, `Community 76`, `Community 77`, `Community 79`, `Community 80`, `Community 81`, `Community 85`, `Community 86`, `Community 87`, `Community 89`, `Community 90`, `Community 91`, `Community 95`, `Community 97`, `Community 98`, `Community 99`, `Community 102`, `Community 104`, `Community 105`, `Community 108`, `Community 111`, `Community 113`, `Community 114`, `Community 115`, `Community 128`, `Community 131`, `Community 135`, `Community 139`, `Community 140`, `Community 149`, `Community 153`, `Community 154`, `Community 163`, `Community 164`, `Community 168`, `Community 174`?**
  _High betweenness centrality (0.034) - this node is a cross-community bridge._
- **Should `Community 2` be split into smaller, more focused modules?**
  _Cohesion score 0.0327979292983016 - nodes in this community are weakly interconnected._