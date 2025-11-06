export interface TranscriptChunk {
  index: number;
  text: string;
  startSec: number;
  endSec: number;
  tokenEstimate: number;
}

interface SplitOptions {
  /**
   * Desired minimum token count per chunk before we consider flushing. Defaults to 400.
   */
  minTokens: number;
  /**
   * Hard upper bound for tokens in a chunk. Defaults to 600.
   */
  maxTokens: number;
  /**
   * Maximum duration (in seconds) of a chunk. Defaults to 60 seconds.
   */
  maxDurationSec: number;
  /**
   * Percentage of tokens to keep between neighbouring chunks. Defaults to 0.18 (18%).
   */
  overlapRatio: number;
  maxChunks?: number;
}

interface DeepgramWord {
  start?: number;
  end?: number;
  word?: string;
  punctuated_word?: string;
}

interface DeepgramUtterance {
  start?: number;
  end?: number;
  transcript?: string;
  speaker?: string;
  words?: DeepgramWord[];
}

interface ParsedTranscript {
  utterances: DeepgramUtterance[];
  transcriptText: string;
}

const DEFAULT_MAX_CHUNKS = 2000;

function normalizeText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim();
}

function estimateTokens(text: string): number {
  if (!text) return 0;
  const words = text.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words * 1.3));
}

function resolveStart(utterance: DeepgramUtterance): number | null {
  const words = Array.isArray(utterance.words) ? utterance.words : [];
  const wordStart = words
    .map((w) => (typeof w?.start === "number" ? w.start : null))
    .filter((v): v is number => v != null);
  if (wordStart.length) {
    return Math.min(...wordStart);
  }
  return typeof utterance.start === "number" ? utterance.start : null;
}

function resolveEnd(utterance: DeepgramUtterance): number | null {
  const words = Array.isArray(utterance.words) ? utterance.words : [];
  const wordEnd = words
    .map((w) => (typeof w?.end === "number" ? w.end : null))
    .filter((v): v is number => v != null);
  if (wordEnd.length) {
    return Math.max(...wordEnd);
  }
  return typeof utterance.end === "number" ? utterance.end : null;
}

function formatUtteranceText(utterance: DeepgramUtterance): string {
  const text = normalizeText(utterance.transcript);
  if (!text) return "";
  const speaker = normalizeText(utterance.speaker);
  if (speaker) {
    return `${speaker}: ${text}`;
  }
  return text;
}

function parseTranscriptJson(transcriptJson: string): ParsedTranscript | null {
  if (!transcriptJson) return null;
  try {
    const parsed = JSON.parse(transcriptJson);
    const utterances = Array.isArray(parsed?.results?.utterances)
      ? (parsed.results.utterances as DeepgramUtterance[])
      : [];
    const transcriptText = normalizeText(
      parsed?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? ""
    );
    return { utterances, transcriptText };
  } catch {
    return null;
  }
}

export function splitTranscript(
  transcriptJson: string,
  options: SplitOptions
): TranscriptChunk[] {
  const parsed = parseTranscriptJson(transcriptJson);
  if (!parsed) return [];

  const utterances = parsed.utterances
    .map((u) => ({
      raw: u,
      text: formatUtteranceText(u),
      start: resolveStart(u),
      end: resolveEnd(u),
    }))
    .filter((item) => item.text.length > 0 && item.start != null && item.end != null)
    .map((item) => ({
      text: item.text,
      start: item.start as number,
      end: item.end as number,
      tokenEstimate: estimateTokens(item.text),
    }));

  const chunks: TranscriptChunk[] = [];
  const minTokens = Math.max(50, Math.round(options.minTokens));
  const maxTokens = Math.max(minTokens, Math.round(options.maxTokens));
  const maxDurationSec = Math.max(10, Number.isFinite(options.maxDurationSec) ? Number(options.maxDurationSec) : 60);
  const overlapTokens = Math.max(
    0,
    Math.round(maxTokens * Math.max(0, Math.min(1, options.overlapRatio)))
  );
  const maxChunks = options.maxChunks ?? DEFAULT_MAX_CHUNKS;

  if (!utterances.length) {
    const text = parsed.transcriptText;
    if (!text) {
      return [];
    }
    const tokenEstimate = estimateTokens(text);
    const chunk: TranscriptChunk = {
      index: 0,
      text,
      startSec: 0,
      endSec: 0,
      tokenEstimate,
    };
    chunks.push(chunk);
    return chunks;
  }

  let buffer: typeof utterances = [];
  let bufferTokens = 0;
  let chunkIndex = 0;

  const flush = () => {
    if (!buffer.length) return;
    const startSec = buffer[0].start;
    const endSec = buffer[buffer.length - 1].end;
    const text = buffer.map((item) => item.text).join("\n");
    const tokenEstimate = buffer.reduce((acc, item) => acc + item.tokenEstimate, 0);
    chunks.push({ index: chunkIndex, text, startSec, endSec, tokenEstimate });
    chunkIndex += 1;
  };

  const carryOverlap = () => {
    if (!overlapTokens || !buffer.length) {
      buffer = [];
      bufferTokens = 0;
      return;
    }
    const preserved: typeof utterances = [];
    let preservedTokens = 0;
    for (let i = buffer.length - 1; i >= 0; i -= 1) {
      const item = buffer[i];
      preserved.unshift(item);
      preservedTokens += item.tokenEstimate;
      if (preservedTokens >= overlapTokens) {
        break;
      }
    }
    buffer = preserved;
    bufferTokens = preservedTokens;
  };

  for (const utterance of utterances) {
    if (chunks.length >= maxChunks) {
      break;
    }

    if (buffer.length) {
      const durationWithNext = Math.max(0, utterance.end - buffer[0].start);
      const wouldExceedTokens = bufferTokens + utterance.tokenEstimate > maxTokens;
      const wouldExceedDuration = durationWithNext > maxDurationSec;
      const flushForDuration = wouldExceedDuration && bufferTokens > 0;
      const flushForTokens = wouldExceedTokens && bufferTokens >= minTokens;
      if (flushForDuration || flushForTokens) {
        const durationOnly = flushForDuration && !flushForTokens;
        flush();
        if (chunks.length >= maxChunks) {
          break;
        }
        if (durationOnly && buffer.length <= 1) {
          buffer = [];
          bufferTokens = 0;
        } else {
          carryOverlap();
        }
      }
    }

    if (!buffer.length) {
      buffer.push(utterance);
      bufferTokens = utterance.tokenEstimate;
      continue;
    }

    buffer.push(utterance);
    bufferTokens += utterance.tokenEstimate;

    const duration = Math.max(0, buffer[buffer.length - 1].end - buffer[0].start);
    const shouldForceFlush = bufferTokens >= maxTokens || duration >= maxDurationSec;
    const singleOversized = buffer.length === 1 && shouldForceFlush;
    if ((shouldForceFlush && bufferTokens >= minTokens) || singleOversized) {
      flush();
      if (chunks.length >= maxChunks) {
        break;
      }
      carryOverlap();
    }
  }

  if (chunks.length < maxChunks && buffer.length) {
    flush();
  }

  return chunks.slice(0, maxChunks);
}
