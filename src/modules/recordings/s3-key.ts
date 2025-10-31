export function buildRecordingKey({
  userId,
  recordingId,
  organizationId,
}: {
  userId: string;
  recordingId: string;
  organizationId?: string | null;
}): string {
  const segments = [] as string[];
  if (organizationId) {
    segments.push(`org_${organizationId}`);
  }
  segments.push(`user_${userId}`);
  segments.push(`rec_${recordingId}`);
  segments.push("audio.m4a");
  return segments.join("/");
}
