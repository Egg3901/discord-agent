const MAX_LENGTH = 1900; // Discord limit is 2000, leave margin

/**
 * Split a long message into Discord-safe chunks, respecting code blocks.
 */
export function splitMessage(text: string): string[] {
  if (text.length <= MAX_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;
  let insideCodeBlock = false;
  let codeBlockLang = '';

  while (remaining.length > 0) {
    if (remaining.length <= MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    let slice = remaining.slice(0, MAX_LENGTH);

    // Track code block state within this slice
    const fences = [...slice.matchAll(/```(\w*)?/g)];
    let sliceInsideCode = insideCodeBlock;
    let sliceLang = codeBlockLang;
    for (const fence of fences) {
      if (sliceInsideCode) {
        sliceInsideCode = false;
      } else {
        sliceInsideCode = true;
        sliceLang = fence[1] || '';
      }
    }

    // Find best split point
    let splitAt = -1;

    if (!sliceInsideCode) {
      // Try paragraph break
      const paraBreak = slice.lastIndexOf('\n\n');
      if (paraBreak > MAX_LENGTH * 0.5) {
        splitAt = paraBreak + 2;
      }
    }

    if (splitAt === -1) {
      // Try line break (outside code block preferred, but any will do)
      const lineBreak = slice.lastIndexOf('\n');
      if (lineBreak > MAX_LENGTH * 0.3) {
        splitAt = lineBreak + 1;
      }
    }

    if (splitAt === -1) {
      // Hard split at max length
      splitAt = MAX_LENGTH;
    }

    let chunk = remaining.slice(0, splitAt);

    // Recount code block state for the actual chunk
    const chunkFences = [...chunk.matchAll(/```(\w*)?/g)];
    let chunkEndsInsideCode = insideCodeBlock;
    let chunkLang = codeBlockLang;
    for (const fence of chunkFences) {
      if (chunkEndsInsideCode) {
        chunkEndsInsideCode = false;
      } else {
        chunkEndsInsideCode = true;
        chunkLang = fence[1] || '';
      }
    }

    // If chunk ends inside a code block, close it
    if (chunkEndsInsideCode) {
      chunk += '\n```';
      insideCodeBlock = true;
      codeBlockLang = chunkLang;
    } else {
      insideCodeBlock = false;
      codeBlockLang = '';
    }

    chunks.push(chunk);

    remaining = remaining.slice(splitAt);

    // If we closed a code block, re-open it in the next chunk
    if (insideCodeBlock) {
      remaining = '```' + codeBlockLang + '\n' + remaining;
    }
  }

  return chunks;
}
