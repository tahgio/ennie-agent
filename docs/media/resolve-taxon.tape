# Highlights gif: resolve_taxon, via the bundled CLI agent.
# Regenerate with: vhs docs/media/resolve-taxon.tape (run from the repo root, after `pnpm build`).

Output docs/media/resolve-taxon.gif

Require pnpm

Set Shell "bash"
Set FontSize 16
Set Width 1200
Set Height 560
Set Theme "GitHub Dark"
Set Padding 20
Set TypingSpeed 40ms

Type "LOG_LEVEL=error pnpm agent"
Enter
Sleep 5s

Type "What's the accepted taxon for Ursus maritimus?"
Sleep 500ms
Enter
Sleep 8s

Type "/exit"
Enter
Sleep 1s
