// SPDX-License-Identifier: Apache-2.0
import { DEFAULT_PROJECTION_JOURNAL_NAMESPACES, type ContentAddressedStorage, type KeyProvider, type ProjectionJournalOptions } from "@mn/storage";

export const PRODUCT_PROJECTION_NAMESPACES = DEFAULT_PROJECTION_JOURNAL_NAMESPACES;

export function configureProductProjectionJournal(store: object, cas: ContentAddressedStorage, keyProvider: KeyProvider): boolean {
  const capable = store as { configureProjectionJournal?: (options: ProjectionJournalOptions) => void };
  if (!capable.configureProjectionJournal) return false;
  capable.configureProjectionJournal({ cas, keyProvider, namespaces: PRODUCT_PROJECTION_NAMESPACES });
  return true;
}


export async function validateProjectionJournal(store: object): Promise<void> {
  await (store as { validateProjectionJournal?: () => Promise<void> }).validateProjectionJournal?.();
}
