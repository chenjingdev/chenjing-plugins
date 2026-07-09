<!-- Shooter prompt template. The door replaces each {{PLACEHOLDER}} and
     deletes every HTML comment before dispatch. The finished prompt is the
     ONLY thing a shooter sees (M2) — anything not written here does not
     exist for the shooter. -->

# Task

{{DEFINITION}}
<!-- the form's definition, verbatim -->

## Criteria

{{CRITERIA}}
<!-- criteria_from = request  : the user's request text, quoted.
     criteria_from = document : sealed → the document content, embedded here;
                                tooled → the document's path.
     criteria_from = shooter  : "Judge by your own reading; state the grounds
                                 for each item." -->

## Target

{{TARGET}}
<!-- sealed : the full target content, embedded (this is all the shooter gets).
     tooled : the repository path(s) plus exactly what the shooter may touch
              (read, edit, run tests…). -->

## Rules

{{RULES}}
<!-- Compose from the form, one line each, dropping lines that do not apply:
     invention = forbidden → "Report only what is present in the target. Point
       at it with an anchor; add nothing the target does not contain."
     fold = union/vote + closed_list → "Anchor every finding to exactly one of
       the allowed anchor values (they appear in your output schema)."
     fold = union/vote + quote → "Anchor every finding with a verbatim quote
       from the target, copied character-for-character."
     residual non-empty → the residual text, verbatim. -->

## Output

{{OUTPUT}}
<!-- fold = union/vote : "Return your findings via the structured output tool:
       a list of {anchor, content} records — one record per finding."
     fold = pick       : "Return one complete candidate via the structured
       output tool."
     fold = none       : describe the deliverable and where to leave it
       (files edited in place, a summary as your final text, …). -->
