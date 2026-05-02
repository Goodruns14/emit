import type { SuggestContext } from "../../types/index.js";

// ─────────────────────────────────────────────
// Context bundle rendering (shared helpers)
// ─────────────────────────────────────────────

function renderExistingEvents(ctx: SuggestContext): string {
  if (ctx.existing_events.length === 0) return "  (no existing events in catalog)";
  return ctx.existing_events
    .map((ev) => {
      const header = `  - ${ev.name}: ${ev.description}`;
      if (ev.properties.length === 0) return header;
      const propLines = ev.properties.map((p) => `      · ${p}`).join("\n");
      return `${header}\n${propLines}`;
    })
    .join("\n");
}

function renderPropertyDefs(ctx: SuggestContext): string {
  const entries = Object.entries(ctx.property_definitions);
  if (entries.length === 0) return "  (no shared property definitions)";
  return entries
    .map(([name, def]) => `  - ${name}: ${def.description}`)
    .join("\n");
}

function renderExemplars(ctx: SuggestContext): string {
  if (ctx.exemplars.length === 0) return "  (no exemplar call sites available)";
  return ctx.exemplars
    .map(
      (ex, i) =>
        `Exemplar ${i + 1} — event "${ex.event_name}" at ${ex.file}:${ex.line}\n\`\`\`\n${ex.code}\n\`\`\``
    )
    .join("\n\n");
}

function renderFeatureFiles(ctx: SuggestContext): string {
  if (!ctx.feature_files || ctx.feature_files.length === 0) return "";
  const blocks = ctx.feature_files
    .map((f) => `File: ${f.file}\n\`\`\`\n${f.code}\n\`\`\``)
    .join("\n\n");
  return `\n\nFeature code the user pointed at:\n\n${blocks}`;
}

function renderTrackPatterns(ctx: SuggestContext): string {
  if (ctx.track_patterns.length === 0) {
    return "(empty — infer the wrapper from the exemplar code below)";
  }
  return ctx.track_patterns.map((p) => `"${p}"`).join(", ");
}

/**
 * Slug-ify a free-text ask for use in a git branch name / reasoning doc filename.
 * Keeps [a-z0-9-], collapses other runs to "-", truncates to 40 chars.
 */
export function slugifyAsk(ask: string): string {
  const raw = ask
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!raw) return "ask";
  if (raw.length <= 40) return raw;

  // Truncate at the last word boundary before the cap so we don't chop mid-word
  // (e.g. "components-yearly-recap" → "components-yearly" not "components-yearl").
  const truncated = raw.slice(0, 40);
  const lastHyphen = truncated.lastIndexOf("-");
  const clipped = lastHyphen > 0 ? truncated.slice(0, lastHyphen) : truncated;
  return clipped.replace(/-+$/g, "") || "ask";
}

// ─────────────────────────────────────────────
// Agent brief — the prompt we hand Claude Code
// ─────────────────────────────────────────────

/**
 * Build the brief that emit hands to Claude Code via `claude <prompt>`.
 *
 * This is NOT a structured-output prompt. It's a prose instruction for an
 * agent that can read files, edit them, run commands, and commit. The agent
 * (Claude Code) handles the multi-turn interaction with the user directly.
 *
 * Emit's role is to pre-bundle context so the agent doesn't have to explore
 * the repo from scratch — it starts with the catalog, exemplars, naming
 * style, and optionally feature code already in hand.
 */
export function buildAgentBrief(args: {
  ctx: SuggestContext;
  /** Slug used to name the reasoning doc file (e.g. "instrument-checkout").
   *  Branch management is intentionally NOT part of this command — the user
   *  decides what branch to be on; emit just commits there. */
  branchSlug: string;
  /** When true, the brief drops every step that requires user interaction
   *  (CLARIFY questions, CONFIRM-before-implement, the `/exit` reminder).
   *  Used when emit launches Claude Code via `-p` / `--permission-mode
   *  acceptEdits` (i.e. `emit suggest --yes`). The agent must instead make
   *  best-judgment defaults and surface uncertainty in the reasoning doc with
   *  `confidence: low` rather than stalling for a human. */
  headless?: boolean;
}): string {
  const { ctx, branchSlug, headless = false } = args;
  const reasoningDocPath = `.emit/suggestions/${branchSlug}.md`;

  const intro = headless
    ? `You are helping a developer instrument analytics events in their repository.
The user has an existing event catalog (from \`emit scan\`), a tracking wrapper
already in use throughout the code, and a free-text ask about what they want
to change. You are running in HEADLESS mode — there is no human on the other
end of this session. Interpret the ask, choose the events/edits yourself using
best-judgment defaults, implement them in code, and leave the changes
uncommitted in the working tree for the user to review later.`
    : `You are helping a developer instrument analytics events in their repository.
The user has an existing event catalog (from \`emit scan\`), a tracking wrapper
already in use throughout the code, and a free-text ask about what they want
to change. Your job is to interpret the ask, propose concrete events or edits,
confirm with the user, implement the changes in code, and commit everything
to a new branch.`;

  const clarifyStep = headless
    ? `2. PROCEED with best-judgment defaults. There is no user to ask. If the ask
   is ambiguous, pick the simplest interpretation, mark every uncertain choice
   \`confidence: low\` in the reasoning doc, and continue. Do NOT stall, do NOT
   write a question and wait for an answer — there will be no answer.`
    : `2. CLARIFY if (and only if) the ask is truly ambiguous AND you can't proceed
   well from the context. Ask at most 2 event-design questions. NEVER ask about:
   user identity, anonymous vs logged-in, session stitching, attribution,
   timezone handling, or CDP destinations. Those are the user's analytics-infra
   concern, not yours.`;

  const confirmStep = headless
    ? `4. SKIP confirmation — there is no user to confirm with. Implement every
   event you proposed in step 3 directly. Mark any you'd normally hedge on as
   \`confidence: low\` in the reasoning doc so the user can drop them on review.`
    : `4. CONFIRM with the user which suggestions to accept. Let them drop any they
   don't want. Iterate if they push back.`;

  const implementStep = headless
    ? `5. IMPLEMENT each proposed suggestion:
   - Match the wrapper shown in the exemplars exactly (function name, arg shape,
     prop casing, import style). If the catalog's track_patterns is empty, infer
     the wrapper from the exemplar code above.
   - Place the call at the user-intent moment (after a successful API response,
     in a submit handler, etc.) — not in a render function.
   - Use in-scope variables; don't invent ones. If you're not sure a variable
     exists, pick the simplest grounded expression and record the uncertainty
     in the reasoning doc with \`confidence: low\`. Do NOT ask — there is no
     user to answer.
   - For "add_property": locate the existing call site and insert one new prop.
   - For "rename_event" / "rename_property": replace the old literal in place.
   - For "global_prop": prefer editing the tracking wrapper / helper if one
     exists, rather than touching every call site.`
    : `5. IMPLEMENT each accepted suggestion:
   - Match the wrapper shown in the exemplars exactly (function name, arg shape,
     prop casing, import style). If the catalog's track_patterns is empty, infer
     the wrapper from the exemplar code above.
   - Place the call at the user-intent moment (after a successful API response,
     in a submit handler, etc.) — not in a render function.
   - Use in-scope variables; don't invent ones. If you're not sure a variable
     exists, pick the simplest grounded expression or ask the user.
   - For "add_property": locate the existing call site and insert one new prop.
   - For "rename_event" / "rename_property": replace the old literal in place.
   - For "global_prop": prefer editing the tracking wrapper / helper if one
     exists, rather than touching every call site.`;

  const reportStep = headless
    ? `7. REPORT briefly:
   - Files modified (list them, no extra commentary)
   - Events instrumented (just the names)
   - Add this exact line: "These changes are in the working tree, uncommitted.
     The user will review them with \`git diff\` and decide whether to keep
     each one."

   Keep it short. Do NOT enumerate git steps. Do NOT suggest pushing or opening
   a PR. The user owns git workflow entirely.`
    : `7. REPORT briefly:
   - Files modified (list them, no extra commentary)
   - Events instrumented (just the names)
   - Add this exact line: "These changes are in your working tree, uncommitted.
     Use git however you normally would — review with \`git diff\`, commit when
     ready, or discard with \`git checkout -- .\` to start over."
   - End with: "Type \`/exit\` to return to emit."

   Keep it short. Do NOT enumerate git steps beyond the line above. Do NOT
   suggest pushing, opening a PR, or any other workflow detail — that's the
   user's call.

   Putting the \`/exit\` reminder at the END of your message is critical — emit
   showed this instruction at session start but it has long since scrolled
   off-screen for the user.`;

  const placementGuardrail = headless
    ? `- If you can't confidently place an event (e.g. the feature code doesn't show
  a clear trigger), record the uncertainty in the reasoning doc with
  \`confidence: low\` and place your best guess. Do NOT stop and ask — there
  is no user to answer.`
    : `- If you can't confidently place an event (e.g. the feature code doesn't show
  a clear trigger), stop and ask the user rather than guessing.`;

  return `
${intro}

─────────────────────────────────────────────
User's ask
─────────────────────────────────────────────
"""
${ctx.user_ask}
"""

─────────────────────────────────────────────
Repo conventions (YOUR OUTPUT MUST MATCH THESE)
─────────────────────────────────────────────
  Naming style:   ${ctx.naming_style}
  Track patterns: ${renderTrackPatterns(ctx)}

Existing events (${ctx.existing_events.length} total):
${renderExistingEvents(ctx)}

Shared property definitions (reuse these names verbatim when a concept already
exists — do not invent parallel names for the same thing):
${renderPropertyDefs(ctx)}

─────────────────────────────────────────────
Exemplar call sites (learn the idiom from these)
─────────────────────────────────────────────
${renderExemplars(ctx)}${renderFeatureFiles(ctx)}

─────────────────────────────────────────────
Naming + governance rules (apply to every event you propose)
─────────────────────────────────────────────

These rules take precedence over copying patterns from existing events. If
an existing event in the catalog violates one of these rules, treat it as
legacy debt — do NOT propagate the bad pattern into your new proposals.

EVENT NAMES
- Use object-action format: <Object> <PastTenseVerb>.
    Good:  "Document Uploaded", "Subscription Cancelled", "Survey Completed"
    Bad:   "Upload Document", "Cancel Sub", "User Did Thing"
- Use past tense for completed actions. Never imperative or present-progressive.
    Good:  "Survey Completed"
    Bad:   "Survey Complete", "Submit Survey", "Submitting Survey"
- Match the granularity of existing events. Don't mix high-level (e.g.
  "Document Added") with low-level (e.g. "Save Button Clicked") in the same
  catalog unless the existing repo already does this intentionally.
- No system or version prefixes ("frontend_*", "v2_*", "new_*"). Events
  should describe what happened, not where in the stack they fired.

PROPERTY NAMES
- Use nouns, not verbs: "documentId" not "did_upload_document".
- Match the casing of existing property names in property_definitions
  (camelCase / snake_case / etc.).
- No abbreviations unless industry-idiomatic (id, url, ts, ip, sso).
- Avoid PII in property names or values when an ID will do. Prefer
  "userId" over "userEmail"; if you must capture an email, flag it
  in the rationale and mention the privacy implication.
- Avoid redundant state: if the event is "Document Uploaded", do NOT
  add a property like "event_type: 'upload'". The event name carries that.
- One concept per property. If a value is "linkedin|twitter|email", use
  one prop "platform"; don't split into "is_linkedin", "is_twitter", etc.

VERBS to prefer (clear, common, machine-friendly):
   Viewed, Clicked, Submitted, Created, Updated, Deleted, Cancelled,
   Started, Completed, Failed, Dismissed, Loaded, Opened, Closed,
   Enabled, Disabled, Shared, Sent, Received, Uploaded, Downloaded.

VERBS to avoid (vague):
   Did, Got, Used, Triggered, Ran, Performed, Handled, Processed.

If you propose an event that bends one of these rules (e.g. the existing
repo's naming style genuinely conflicts with object+past-verb format),
explain the choice in the rationale rather than ignoring the rule silently.

─────────────────────────────────────────────
Your workflow
─────────────────────────────────────────────

1. CLASSIFY the ask. It'll be one of:
   - "measure"         — user wants to answer a metric/funnel; propose new events to fill gaps
   - "edit_event"      — user wants to modify an existing event (add/rename prop, rename event, etc.)
   - "global_prop"     — user wants to add a single property to many events
   - "feature_launch"  — user pointed at feature code; propose events for value moments
   - "other"           — generic edit

${clarifyStep}

3. PROPOSE events or edits. For each, tell the user:
   - The event name (in the repo's naming style)
   - What it captures and when it fires
   - The properties, presented as TWO labeled sections so the reviewer
     can tell reused props from new ones. Use these exact labels (NOT
     "props" — emit's catalogs use the full word), one property per line:

         Shared Properties (reused from property_definitions):
           - teamId
           - organization_id

         Unique Properties (new for this event):
           - slide
           - slideIndex
           - year

     Rules:
       · Show each property on its own line with a bullet — never
         comma-separated.
       · If a section has no entries, write "(none)" instead of listing
         properties from the other section under it.
       · Shared properties must be names that appear in the
         property_definitions list above. Do not invent shared names.
       · Unique properties may include a short type hint in parentheses
         (e.g. "slideIndex (number)" or "completed (boolean)").
   - A one-sentence rationale tying back to the ask

   Show shared properties once at the top of the group, unique props per event
   below each. Confidence should be explicit (high/medium/low).

${confirmStep}

${implementStep}

6. PACKAGE the work. Just two file-writes, then stop:

   [  ] A. **CHECK \`emit.config.yml\` for a \`manual_events:\` list.** If it
          exists AND you're adding any brand-new event names, APPEND the new
          names to that list now. This is NOT optional — without it, the
          post-merge \`emit scan\` will NOT find your new events and the
          catalog will remain stale. Match the quoting convention of existing
          entries (e.g. if other YIR events are quoted as \`"YIR: Foo"\`,
          quote yours the same way). If the config has no \`manual_events:\`
          list (automatic discovery mode), skip this box.

   [  ] B. Write the reasoning doc at \`${reasoningDocPath}\` containing:
          · The user's original ask (verbatim)
          · Any clarifying Q&A
          · The list of proposed + accepted events (with rationale + confidence)
          · For each instrumented event: the file + line + why you placed it there
          · Any edge cases flagged for the reviewer

   [  ] C. **STOP.** Your job ends here. Do NOT run any of these commands:
          · \`git add\`
          · \`git commit\`
          · \`git checkout\` (no branch creation or switching)
          · \`git stash\`
          · \`git push\`
          · \`gh pr create\`
          The user owns git workflow entirely — staging, committing, branching,
          pushing, PR-opening — all of it. Your job is to leave the modified
          files in the working tree and let the user decide what to do with them.

${reportStep}

─────────────────────────────────────────────
Guardrails
─────────────────────────────────────────────

- Only modify files that directly relate to the accepted suggestions plus the
  reasoning doc. Don't refactor unrelated code.
- Never touch \`emit.catalog.yml\` — the catalog is an output. It updates itself
  on the next \`emit scan\` after merge. (See PACKAGE step box A for
  \`emit.config.yml\` — that's a different file and you DO update it.)
${placementGuardrail}
- If the user's working tree has unrelated uncommitted changes, only stage
  the files YOU edited (the source files plus \`emit.config.yml\` and the
  reasoning doc). Don't sweep everything into the commit with \`git add -A\`.
- Keep suggestions scoped to the ask. A "measure survey drop-off" ask produces
  ~2–4 events, not a full instrumentation redesign.
`.trim();
}
