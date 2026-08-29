/**
 * Redirect every console channel that would otherwise write to stdout.
 *
 * This module exists for its side effect and must be imported *first* by the
 * stdio entrypoint, before the MCP SDK or any other dependency is loaded. ES
 * modules evaluate their dependencies in import order, so being first in the
 * list is what makes "before any other module" true rather than hopeful.
 *
 * Constitution I: in stdio mode, nothing but JSON-RPC frames may reach stdout.
 * The lint rule and the protocol test both guard our own code, but neither can
 * stop a transitive dependency from calling `console.log` on some unlucky code
 * path — and the symptom of that would be a client-side JSON parse error with
 * no visible cause. So the channels are rerouted rather than merely forbidden.
 *
 * Everything still gets printed; it just goes to stderr, where it belongs.
 */

const stderrWrite = console.error.bind(console)

console.log = stderrWrite
console.info = stderrWrite
console.debug = stderrWrite
console.dir = stderrWrite
console.table = stderrWrite
console.trace = stderrWrite

/**
 * `process.stdout.write` is left alone on purpose: it is the transport's own
 * channel, and hijacking it would break the very protocol this guard protects.
 */
export {}
