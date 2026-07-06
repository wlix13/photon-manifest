/** R2 key for a distribution file. */
export function fileKey(project: string, filename: string): string {
  return `packages/${project}/${filename}`;
}

/** R2 key for a file's extracted core metadata (PEP 658: file URL + ".metadata"). */
export function metadataKey(project: string, filename: string): string {
  return `${fileKey(project, filename)}.metadata`;
}

/** Deletes both the file object and its metadata object, ignoring absent keys. */
export async function deleteFileObjects(
  bucket: R2Bucket,
  project: string,
  filename: string,
): Promise<void> {
  await bucket.delete([fileKey(project, filename), metadataKey(project, filename)]);
}
