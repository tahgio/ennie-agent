# Highlights gif: the species_distribution_report MCP prompt, via the MCP Inspector CLI.
#
# The bundled CLI agent only pulls MCP *tools*, not MCP *prompts* -- a prompt is
# invoked by a prompt-aware client (a slash command in most GUI clients). This
# uses the Inspector's --cli mode to fetch the same templated workflow a GUI
# client would show, exactly as the Quickstart's Inspector example does for tools.
#
# Regenerate with: vhs docs/media/prompt-template.tape (run from the repo root, after `pnpm build`).

Output docs/media/prompt-template.gif

Require npx

Set Shell "bash"
Set FontSize 15
Set Width 1200
Set Height 640
Set Theme "GitHub Dark"
Set Padding 20
Set TypingSpeed 35ms

Type `npx @modelcontextprotocol/inspector --cli node packages/mcp-server/dist/index.js --method prompts/get --prompt-name species_distribution_report --prompt-args species="snow leopard"`
Enter
Sleep 8s
