<!-- Runner prompt template. The door replaces each {{PLACEHOLDER}} and
     deletes every HTML comment before dispatch. The finished prompt is the
     ONLY thing a runner sees (M2) — anything not written here does not
     exist for the runner. -->

# Task

{{DEFINITION}}
<!-- the form's definition, verbatim -->

## Criteria

{{CRITERIA}}
<!-- criteria_from = request  : the user's request text, quoted.
     criteria_from = document : sealed → the document content, embedded here;
                                tooled → the document's path.
     criteria_from = runner   : "Judge by your own reading; state the grounds
                                 for each item." -->

## Target

{{TARGET}}
<!-- sealed : the full target content, embedded (this is all the runner gets).
     tooled : the repository path(s) plus exactly what the runner may touch
              (read, edit, run tests…). -->

## Rules

{{RULES}}
<!-- Compose from the form, one line each, dropping lines that do not apply:
     invention = forbidden → "Report only what is present in the target. Point
       at it with an anchor; add nothing the target does not contain."
     merge = union/vote + closed_list → "Anchor every finding to exactly one of
       the allowed anchor values (they appear in your output schema)."
     merge = union/vote + quote → "Anchor every finding with a verbatim quote
       from the target, copied character-for-character."
     notes non-empty → the notes text, verbatim. -->

## Output

{{OUTPUT}}
<!-- merge = union/vote : "Return your findings via the structured output tool:
       a list of {anchor, content} records — one record per finding."
     merge = pick       : "Return one complete candidate via the structured
       output tool."
     merge = none       : describe the deliverable and where to leave it
       (files edited in place, a summary as your final text, …). -->
