# Highlights gif: search_occurrences, via the bundled CLI agent.
# Regenerate with: vhs docs/media/search-occurrences.tape (run from the repo root, after `pnpm build`).

Output docs/media/search-occurrences.gif

Require pnpm

Set Shell "bash"
Set FontSize 16
Set Width 1200
Set Height 640
Set Theme "GitHub Dark"
Set Padding 20
Set TypingSpeed 40ms

Type "LOG_LEVEL=error pnpm agent"
Enter
Sleep 5s

Type "Show me 5 recent polar bear occurrence records"
Sleep 500ms
Enter
Sleep 10s

Type "/exit"
Enter
Sleep 1s
