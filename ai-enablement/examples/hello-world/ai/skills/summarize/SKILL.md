---
name: summarize
description: Summarize the document (or the selection) at the length the user wants, and optionally put the summary at the top of the document. Use when the user asks for a summary, a TL;DR, key points, or an abstract.
allowed-tools: insert_text get_selection
---

# Summarizing

1. Summarize what the page snapshot shows (or only the selection, when the user points at "this part").
2. Length: one sentence for "TL;DR"; 3–5 bullet points for "key points"; otherwise a short paragraph of at most
   80 words. Keep the document's own terms; add nothing the text does not say.
3. Answer in the chat first. Only when the user asks to add it to the document, call `insert_text` with
   `where: "start"` and the summary followed by a blank line (the user confirms; Ctrl+Z undoes it).
