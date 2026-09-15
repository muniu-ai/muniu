// SPDX-License-Identifier: Apache-2.0
import type { ContentAddressedStorage, KeyProvider, ProjectionJournalOptions } from "@mn/storage";

export const PRODUCT_PROJECTION_NAMESPACES = Object.freeze(["*non-core"]);

export function configureProductProjectionJournal(store: object, cas: ContentAddressedStorage, keyProvider: KeyProvider): boolean {
  const capable = store as { configureProjectionJournal?: (options: ProjectionJournalOptions) => void };
  if (!capable.configureProjectionJournal) return false;
  capable.configureProjectionJournal({ cas, keyProvider, namespaces: PRODUCT_PROJECTION_NAMESPACES });
  return true;
}
