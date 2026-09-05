import type { SupabaseClient, User } from "@supabase/supabase-js";
import { createSupabaseBrowserClient } from "./supabase/client";
import {
  SAVED_LESSON_SCHEMA_VERSION,
  deleteSavedLesson,
  getSavedLessonContentSignature,
  listSavedLessons,
  parseSavedLesson,
  saveSavedLesson,
  updateSavedLessonCloudSync,
  type SavedLesson,
} from "./local-persistence";

export type CloudSyncState = "local-only" | "syncing" | "synced" | "pending" | "error";
export type CloudSyncSummary = {
  uploaded: number;
  downloaded: number;
  unchanged: number;
  conflicts: number;
  deferred: number;
  cloudLessonCount: number;
};

type CloudLessonRow = {
  id: string;
  user_id: string;
  title: string;
  lesson_focus: string | null;
  has_started: boolean;
  snapshot_schema_version: number;
  snapshot: unknown;
  created_at: string;
  updated_at: string;
};

let operationQueue: Promise<unknown> = Promise.resolve();

function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = operationQueue.then(operation, operation);
  operationQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function authenticatedClient(expectedUserId?: string) {
  const client = createSupabaseBrowserClient();
  if (!client) throw new Error("cloud-not-configured");
  const { data, error } = await client.auth.getUser();
  if (error || !data.user || (expectedUserId && data.user.id !== expectedUserId)) {
    throw new Error("cloud-auth-required");
  }
  return { client, user: data.user };
}

export function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function createCloudCompatibleLessonId() {
  if (typeof crypto === "undefined" || typeof crypto.randomUUID !== "function") {
    throw new Error("secure-uuid-unavailable");
  }
  return crypto.randomUUID();
}

export function toCloudSnapshot(lesson: SavedLesson): SavedLesson {
  const snapshot = structuredClone(lesson);
  delete snapshot.cloudOwnerId;
  delete snapshot.cloudSync;
  return snapshot;
}

function snapshotBytes(lesson: SavedLesson) {
  return new TextEncoder().encode(JSON.stringify(toCloudSnapshot(lesson))).byteLength;
}

async function upsertSnapshot(client: SupabaseClient, user: User, lesson: SavedLesson) {
  const snapshot = toCloudSnapshot(lesson);
  const values = {
    user_id: user.id,
    title: lesson.title,
    lesson_focus: lesson.lessonFocus || null,
    has_started: lesson.hasStarted,
    snapshot_schema_version: SAVED_LESSON_SCHEMA_VERSION,
    snapshot,
  };
  const request = lesson.cloudSync
    ? client.from("lessons").update(values)
      .eq("id", lesson.id)
      .eq("updated_at", lesson.cloudSync.lastKnownCloudUpdatedAt)
    : client.from("lessons").insert({ id: lesson.id, ...values });
  const { data, error } = await request.select("updated_at").maybeSingle();
  if (error || typeof data?.updated_at !== "string") throw new Error("cloud-upsert-failed");
  return data.updated_at;
}

async function uploadLesson(
  client: SupabaseClient,
  user: User,
  lesson: SavedLesson,
  debug?: (message: string) => void,
) {
  if (lesson.cloudOwnerId !== user.id || !isUuid(lesson.id)) {
    throw new Error("cloud-lesson-ownership-invalid");
  }
  let candidate = lesson;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    debug?.(`Cloud upsert: id=${candidate.id}`);
    const cloudUpdatedAt = await upsertSnapshot(client, user, candidate);
    const synced = await updateSavedLessonCloudSync(candidate.id, candidate.updatedAt, {
      lastSyncedLocalUpdatedAt: candidate.updatedAt,
      lastKnownCloudUpdatedAt: cloudUpdatedAt,
    });
    debug?.(`Cloud lesson uploaded: id=${candidate.id}, snapshotBytes=${snapshotBytes(candidate)}`);
    if (synced) return synced;
    const latest = (await listSavedLessons()).find((item) => item.id === candidate.id);
    if (!latest || latest.cloudOwnerId !== user.id) throw new Error("cloud-local-lesson-changed");
    candidate = {
      ...latest,
      cloudSync: {
        lastSyncedLocalUpdatedAt: candidate.updatedAt,
        lastKnownCloudUpdatedAt: cloudUpdatedAt,
      },
    };
  }
  throw new Error("cloud-local-lesson-busy");
}

export function associateCloudLesson(
  lesson: SavedLesson,
  expectedUserId: string,
  debug?: (message: string) => void,
) {
  return serialize(async () => {
    const { client, user } = await authenticatedClient(expectedUserId);
    if (lesson.cloudOwnerId !== user.id || !isUuid(lesson.id)) {
      throw new Error("cloud-lesson-ownership-invalid");
    }
    const { data: existing, error: lookupError } = await client.from("lessons")
      .select("id,user_id,title,lesson_focus,has_started,snapshot_schema_version,snapshot,created_at,updated_at")
      .eq("id", lesson.id)
      .maybeSingle();
    if (lookupError) throw new Error("cloud-import-lookup-failed");
    const existingLesson = existing
      ? parseCloudRow(existing as CloudLessonRow, user.id)
      : null;
    if (existingLesson &&
        getSavedLessonContentSignature(existingLesson) === getSavedLessonContentSignature(lesson)) {
      debug?.(`Cloud import identity recovered: id=${lesson.id}`);
      return {
        ...lesson,
        updatedAt: existingLesson.updatedAt,
        cloudSync: existingLesson.cloudSync,
      };
    }
    const candidate: SavedLesson = existing
      ? {
        ...lesson,
        id: createCloudCompatibleLessonId(),
        title: `${lesson.title} (Local import copy)`,
      }
      : lesson;
    const cloudUpdatedAt = await upsertSnapshot(client, user, candidate);
    debug?.(`Cloud lesson uploaded: id=${candidate.id}, snapshotBytes=${snapshotBytes(candidate)}`);
    if (existing) {
      debug?.(`Conflict copy created: original=${lesson.id}, copy=${candidate.id}, reason=divergent-import-identity`);
    }
    return {
      ...candidate,
      cloudSync: {
        lastSyncedLocalUpdatedAt: candidate.updatedAt,
        lastKnownCloudUpdatedAt: cloudUpdatedAt,
      },
    };
  });
}

export function uploadCloudLesson(
  lesson: SavedLesson,
  expectedUserId: string,
  debug?: (message: string) => void,
) {
  return serialize(async () => {
    const { client, user } = await authenticatedClient(expectedUserId);
    return uploadLesson(client, user, lesson, debug);
  });
}

function parseCloudRow(row: CloudLessonRow, ownerId: string): SavedLesson | null {
  if (row.user_id !== ownerId || row.snapshot_schema_version !== SAVED_LESSON_SCHEMA_VERSION) {
    return null;
  }
  const parsed = parseSavedLesson(row.snapshot);
  if (!parsed || parsed.id !== row.id) return null;
  return {
    ...parsed,
    cloudOwnerId: ownerId,
    cloudSync: {
      lastSyncedLocalUpdatedAt: parsed.updatedAt,
      lastKnownCloudUpdatedAt: row.updated_at,
    },
  };
}

function snapshotsEqual(local: SavedLesson, cloud: SavedLesson) {
  return getSavedLessonContentSignature(local) === getSavedLessonContentSignature(cloud);
}

export function reconcileCloudLessons(options: {
  userId: string;
  deferDownloadLessonId?: string | null;
  debug?: (message: string) => void;
}) {
  return serialize(async (): Promise<CloudSyncSummary> => {
    const { client, user } = await authenticatedClient(options.userId);
    const shortUser = user.id.slice(0, 8);
    options.debug?.(`Cloud sync started: user=${shortUser}`);
    const { data, error } = await client.from("lessons")
      .select("id,user_id,title,lesson_focus,has_started,snapshot_schema_version,snapshot,created_at,updated_at")
      .order("updated_at", { ascending: false });
    if (error) throw new Error("cloud-fetch-failed");
    const rows = (data ?? []) as CloudLessonRow[];
    options.debug?.(`Cloud lessons fetched: ${rows.length}`);

    const allLocal = await listSavedLessons();
    const localById = new Map(
      allLocal.filter((lesson) => lesson.cloudOwnerId === user.id)
        .map((lesson) => [lesson.id, lesson]),
    );
    const cloudIds = new Set(rows.map((row) => row.id));
    const summary: CloudSyncSummary = {
      uploaded: 0,
      downloaded: 0,
      unchanged: 0,
      conflicts: 0,
      deferred: 0,
      cloudLessonCount: rows.length,
    };

    for (const row of rows) {
      const cloud = parseCloudRow(row, user.id);
      if (!cloud) {
        options.debug?.(`Cloud lesson skipped: id=${row.id}, category=invalid-snapshot`);
        continue;
      }
      const local = localById.get(row.id);
      if (!local) {
        await saveSavedLesson(cloud);
        summary.downloaded += 1;
        options.debug?.(`Cloud sync lesson: id=${row.id}, owner=${shortUser}, localState=downloaded`);
        options.debug?.(`Cloud lesson downloaded: id=${row.id}`);
        continue;
      }
      localById.delete(row.id);
      const localChanged = !local.cloudSync ||
        local.updatedAt !== local.cloudSync.lastSyncedLocalUpdatedAt;
      const cloudChanged = !local.cloudSync ||
        row.updated_at !== local.cloudSync.lastKnownCloudUpdatedAt;
      options.debug?.(
        `Cloud reconciliation: id=${row.id}, localChanged=${localChanged ? "yes" : "no"}, ` +
        `cloudChanged=${cloudChanged ? "yes" : "no"}`,
      );
      if (snapshotsEqual(local, cloud)) {
        await saveSavedLesson(cloud);
        summary.unchanged += 1;
        options.debug?.(`Cloud lesson unchanged: id=${row.id}`);
        continue;
      }

      if (localChanged && !cloudChanged) {
        await uploadLesson(client, user, local, options.debug);
        summary.uploaded += 1;
      } else if (!localChanged && cloudChanged) {
        if (options.deferDownloadLessonId === row.id) {
          summary.deferred += 1;
          continue;
        }
        await saveSavedLesson(cloud);
        summary.downloaded += 1;
        options.debug?.(`Cloud lesson downloaded: id=${row.id}`);
      } else if (localChanged && cloudChanged) {
        if (options.deferDownloadLessonId === row.id) {
          summary.deferred += 1;
          continue;
        }
        options.debug?.(`Cloud sync conflict detected: id=${row.id}`);
        const now = new Date().toISOString();
        const conflict: SavedLesson = {
          ...structuredClone(local),
          id: createCloudCompatibleLessonId(),
          title: `${local.title} (Local conflict copy)`,
          cloudOwnerId: user.id,
          cloudSync: undefined,
          createdAt: now,
          updatedAt: now,
        };
        const conflictCloudUpdatedAt = await upsertSnapshot(client, user, conflict);
        const syncedConflict: SavedLesson = {
          ...conflict,
          cloudSync: {
            lastSyncedLocalUpdatedAt: conflict.updatedAt,
            lastKnownCloudUpdatedAt: conflictCloudUpdatedAt,
          },
        };
        options.debug?.(`Cloud lesson uploaded: id=${conflict.id}, snapshotBytes=${snapshotBytes(conflict)}`);
        await saveSavedLesson(syncedConflict);
        await saveSavedLesson(cloud);
        summary.conflicts += 1;
        summary.uploaded += 1;
        summary.downloaded += 1;
        options.debug?.(
          `Conflict copy created: original=${row.id}, copy=${conflict.id}, reason=both-revisions-changed`,
        );
      } else {
        await saveSavedLesson({ ...local, cloudSync: cloud.cloudSync });
        summary.unchanged += 1;
      }
    }

    for (const local of localById.values()) {
      if (!cloudIds.has(local.id)) {
        if (!local.cloudSync) {
          options.debug?.(`Cloud sync lesson: id=${local.id}, owner=${shortUser}, localState=new`);
          await uploadLesson(client, user, local, options.debug);
          summary.uploaded += 1;
          continue;
        }
        if (options.deferDownloadLessonId === local.id) {
          summary.deferred += 1;
          continue;
        }
        const locallyChanged = local.updatedAt !== local.cloudSync.lastSyncedLocalUpdatedAt;
        if (!locallyChanged) {
          await deleteSavedLesson(local.id);
          summary.downloaded += 1;
          options.debug?.(`Cloud deletion applied locally: id=${local.id}`);
          continue;
        }
        const now = new Date().toISOString();
        const conflict: SavedLesson = {
          ...structuredClone(local),
          id: createCloudCompatibleLessonId(),
          title: `${local.title} (Local conflict copy)`,
          cloudSync: undefined,
          createdAt: now,
          updatedAt: now,
        };
        const conflictCloudUpdatedAt = await upsertSnapshot(client, user, conflict);
        await saveSavedLesson({
          ...conflict,
          cloudSync: {
            lastSyncedLocalUpdatedAt: conflict.updatedAt,
            lastKnownCloudUpdatedAt: conflictCloudUpdatedAt,
          },
        });
        options.debug?.(`Cloud lesson uploaded: id=${conflict.id}, snapshotBytes=${snapshotBytes(conflict)}`);
        await deleteSavedLesson(local.id);
        summary.conflicts += 1;
        summary.uploaded += 1;
        options.debug?.(
          `Conflict copy created: original=${local.id}, copy=${conflict.id}, reason=remote-delete-local-change`,
        );
      }
    }

    options.debug?.(
      `Cloud sync completed: uploaded=${summary.uploaded}, downloaded=${summary.downloaded}, ` +
      `unchanged=${summary.unchanged}, conflicts=${summary.conflicts}`,
    );
    return { ...summary, cloudLessonCount: rows.length + summary.uploaded };
  });
}

export function deleteCloudLesson(id: string, expectedUserId: string, debug?: (message: string) => void) {
  return serialize(async () => {
    const { client } = await authenticatedClient(expectedUserId);
    const { error, count } = await client.from("lessons")
      .delete({ count: "exact" })
      .eq("id", id);
    if (error || count !== 1) throw new Error("cloud-delete-failed");
    debug?.(`Cloud lesson deleted: id=${id}`);
  });
}
