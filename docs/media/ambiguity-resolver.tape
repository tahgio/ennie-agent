# Highlights gif: the cross-kingdom homonym guard in resolve_taxon, via the bundled CLI agent.
# Regenerate with: vhs docs/media/ambiguity-resolver.tape (run from the repo root, after `pnpm build`).

Output docs/media/ambiguity-resolver.gif

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

Type "What's the accepted taxon for Prunella?"
Sleep 500ms
Enter
Sleep 8s

Type "/exit"
Enter
Sleep 1s
