import { describe, expect, it } from "vitest";
import { splitTranscript } from "../src/modules/embeddings/chunker";

const buildTranscript = (utterances: Array<{ start: number; end: number; text: string; speaker?: string }>) =>
  JSON.stringify({
    results: {
      utterances: utterances.map((u, idx) => ({
        start: u.start,
        end: u.end,
        transcript: u.text,
        speaker: u.speaker ?? `spk_${idx}`,
        words: [
          { start: u.start, end: (u.start + u.end) / 2, word: "word1" },
          { start: (u.start + u.end) / 2, end: u.end, word: "word2" },
        ],
      })),
    },
  });

describe("splitTranscript", () => {
  it("splits long transcripts into multiple chunks with overlap", () => {
    const transcript = buildTranscript(
      Array.from({ length: 6 }).map((_, idx) => ({
        start: idx * 10,
        end: idx * 10 + 8,
        text: `Утверждение номер ${idx} с большим количеством слов для проверки деления на чанки`,
      }))
    );

    const chunks = splitTranscript(transcript, {
      minTokens: 100,
      maxTokens: 140,
      maxDurationSec: 45,
      overlapRatio: 0.2,
    });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeGreaterThan(0);
      expect(chunk.startSec).toBeLessThanOrEqual(chunk.endSec);
    }
  });

  it("falls back to single chunk when utterances missing", () => {
    const transcript = JSON.stringify({
      results: {
        channels: [
          {
            alternatives: [
              {
                transcript: "Это общее описание встречи без таймкодов",
              },
            ],
          },
        ],
      },
    });

    const chunks = splitTranscript(transcript, {
      minTokens: 80,
      maxTokens: 120,
      maxDurationSec: 60,
      overlapRatio: 0.15,
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toContain("общее описание");
    expect(chunks[0]?.startSec).toBe(0);
    expect(chunks[0]?.endSec).toBe(0);
  });
  it("splits when duration exceeds the cap even if tokens are low", () => {
    const transcript = buildTranscript([
      { start: 0, end: 50, text: "Первая реплика длинная по времени", speaker: "A" },
      { start: 55, end: 115, text: "Вторая реплика тоже длинная", speaker: "B" },
    ]);

    const chunks = splitTranscript(transcript, {
      minTokens: 30,
      maxTokens: 400,
      maxDurationSec: 60,
      overlapRatio: 0.2,
    });

    expect(chunks.length).toBe(2);
    expect(chunks[0]?.endSec - chunks[0]?.startSec).toBeLessThanOrEqual(60);
  });
});
