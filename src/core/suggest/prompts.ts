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
  branchSlug: string;
}): string {
  const { ctx, branchSlug } = args;
  const branchName = `emit/suggest-${branchSlug}`;
  const reasoningDocPath = `.emit/suggestions/${branchSlug}.md`;

  return `
You are helping a developer instrument analytics events in their repository.
The user has an existing event catalog (from \`emit scan\`), a tracking wrapper
already in use throughout the code, and a free-text ask about what they want
to change. Your job is to interpret the ask, propose concrete events or edits,
confirm with the user, implement the changes in code, and commit everything
to a new branch.

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
Your workflow
─────────────────────────────────────────────

1. CLASSIFY the ask. It'll be one of:
   - "measure"         — user wants to answer a metric/funnel; propose new events to fill gaps
   - "edit_event"      — user wants to modify an existing event (add/rename prop, rename event, etc.)
   - "global_prop"     — user wants to add a single property to many events
   - "feature_launch"  — user pointed at feature code; propose events for value moments
   - "other"           — generic edit

2. CLARIFY if (and only if) the ask is truly ambiguous AND you can't proceed
   well from the context. Ask at most 2 event-design questions. NEVER ask about:
   user identity, anonymous vs logged-in, session stitching, attribution,
   timezone handling, or CDP destinations. Those are the user's analytics-infra
   concern, not yours.

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

4. CONFIRM with the user which suggestions to accept. Let them drop any they
   don't want. Iterate if they push back.

5. IMPLEMENT each accepted suggestion:
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
     exists, rather than touching every call site.

6. PACKAGE the work. Follow this checklist IN ORDER. You MUST complete every
   box before running \`git commit\`:

   [  ] A. Create the new branch: \`git checkout -b ${branchName}\`

   [  ] B. **CHECK \`emit.config.yml\` for a \`manual_events:\` list.** If it
          exists AND you're adding any brand-new event names, APPEND the new
          names to that list now. This is NOT optional — without it, the
          post-merge \`emit scan\` will NOT find your new events and the
          catalog will remain stale. Match the quoting convention of existing
          entries (e.g. if other YIR events are quoted as \`"YIR: Foo"\`,
          quote yours the same way). If the config has no \`manual_events:\`
          list (automatic discovery mode), skip this box.

   [  ] C. Write the reasoning doc at \`${reasoningDocPath}\` containing:
          · The user's original ask (verbatim)
          · Any clarifying Q&A
          · The list of proposed + accepted events (with rationale + confidence)
          · For each instrumented event: the file + line + why you placed it there
          · Any edge cases flagged for the reviewer

   [  ] D. Stage EVERYTHING in a single \`git add\`:
          · The modified source files (code changes)
          · \`emit.config.yml\` if you updated it in box B
          · \`.emit/suggestions/\` (the reasoning doc directory)

   [  ] E. Make ONE commit with a message like
          \`emit suggest: add <event names...>\`. Do NOT split into multiple
          commits — one commit keeps the branch easy to review and revert.

   [  ] F. Do NOT push. Do NOT open a PR. The user will handle that.

   If you realize mid-commit that you forgot a box (especially B), stop,
   amend or redo the staging, and re-commit. It is always easier to get
   this right the first time than to ship a half-finished commit.

7. REPORT briefly to the user what you did, and tell them to \`/exit\`:
   - Branch name
   - Number of files changed
   - Events instrumented
   - Next step (show this exact line so the user can copy it):
     \`git push -u origin ${branchName} && gh pr create\`
   - End with a line that says explicitly:
     "Type \`/exit\` to return to emit, which will then verify the new events
     with \`emit scan --fresh\`."
   Putting the \`/exit\` reminder at the END of your final message is critical
   — emit showed this instruction at session start but it has long since
   scrolled off-screen for the user.

─────────────────────────────────────────────
Guardrails
─────────────────────────────────────────────

- Only modify files that directly relate to the accepted suggestions plus the
  reasoning doc. Don't refactor unrelated code.
- Never touch \`emit.catalog.yml\` — the catalog is an output. It updates itself
  on the next \`emit scan\` after merge. (See PACKAGE step box B for
  \`emit.config.yml\` — that's a different file and you DO update it.)
- If you can't confidently place an event (e.g. the feature code doesn't show
  a clear trigger), stop and ask the user rather than guessing.
- If the user's working tree has uncommitted changes when you start, stash or
  ask them to stash before creating the branch — don't carry unrelated changes
  into the commit.
- Keep suggestions scoped to the ask. A "measure survey drop-off" ask produces
  ~2–4 events, not a full instrumentation redesign.
`.trim();
}
