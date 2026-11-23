/** Legacy/plain output remains readable when no completed message is present. */
export function codexFinalMessage(stdout: string): string {
  let last: string | undefined
  for (const line of stdout.split('\n')) {
    try {
      const event = JSON.parse(line) as {type?: unknown; item?: {type?: unknown; text?: unknown}} | null
      if (event?.type === 'item.completed' && event.item?.type === 'agent_message' && typeof event.item.text === 'string') {
        last = event.item.text
      }
    } catch {
      // Plain text and incomplete event lines are allowed in the fallback.
    }
  }
  return last ?? stdout
}
