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
  const safeUser = userId.replace(/[^A-Za-z0-9._-]/g, "_");
  segments.push(`user_${safeUser}`);
  segments.push(`rec_${recordingId}`);
  segments.push("audio.m4a");
  return segments.join("/");
}
