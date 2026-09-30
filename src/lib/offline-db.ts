import Dexie, { type Table } from 'dexie';

export interface PendingUpload {
  id?: number;
  // Bytes do arquivo. Guardamos como ArrayBuffer (e não Blob) porque o WebKit/Safari
  // (especialmente em aparelhos iOS mais antigos e com pouca RAM) tem um bug conhecido
  // de corrupção/truncamento de Blobs persistidos no IndexedDB sob pressão de memória —
  // isso causava uploads que chegavam truncados no servidor ("Unexpected end of form").
  // ArrayBuffer é clonado de forma estruturada pelo IndexedDB e não sofre desse problema.
  fileData: ArrayBuffer;
  fileName: string;
  fileType: string;
  timestamp: number;
  token: string | null;
  accountKey?: string | null;
  status: 'pending' | 'uploading' | 'failed';
  error?: string;
  // Conta quantas vezes o envio já foi tentado e falhou. Sem isso, uma foto
  // que nunca vai conseguir subir (ex.: bloqueio de rede específico daquele
  // envio) ficava sendo retentada silenciosamente para sempre a cada 30s,
  // sem nunca dar nenhum sinal claro de que algo está permanentemente
  // quebrado — só o mesmo erro genérico de rede se repetindo.
  attempts?: number;
  // This is used to map the local temporary ID to the final server URL
  localId: string;
  /** @deprecated Registros antigos (antes da migração para fileData) guardavam um Blob aqui. Mantido só para leitura retrocompatível. */
  file?: Blob;
}

export interface PendingApiCall {
  id?: number;
  url: string;
  method: string;
  body: any;
  headers: Record<string, string>;
  timestamp: number;
  status: 'pending' | 'processing' | 'failed';
  error?: string;
  attempts?: number;
  retryAt?: number;
  idempotencyKey?: string;
  accountKey?: string | null;
  // If this API call depends on uploads, store the localIds of those uploads.
  dependsOnUploadIds?: string[];
  /** @deprecated Registros antigos guardavam apenas uma dependência. Mantido para leitura retrocompatível. */
  dependsOnUploadId?: string;
}

// Lease de sincronização: garante que apenas UMA aba/dispositivo processe a
// fila por vez, mesmo após reload ou crash da aba anterior. O dono do lease
// renova o heartbeat; se a aba morre, o lease expira e outra aba assume.
export interface OfflineCategoryState {
  key: string;
  accountKey: string | null;
  routeId: string;
  categoryId: string;
  routeBrandId?: string | null;
  photoType: 'before' | 'after';
  photoCount: number;
  status: 'pending' | 'synced' | 'failed';
  updatedAt: number;
  error?: string;
}

export interface SyncLease {
  name: string; // 'offline-sync'
  ownerId: string;
  accountKey: string | null;
  acquiredAt: number;
  expiresAt: number;
}

export interface UploadMapping {
  localId: string;
  serverUrl: string;
  timestamp: number;
  accountKey?: string | null;
}

export class OfflineDatabase extends Dexie {
  pending_uploads!: Table<PendingUpload>;
  pending_api_calls!: Table<PendingApiCall>;
  upload_mappings!: Table<UploadMapping>;
  sync_leases!: Table<SyncLease>;
  offline_category_states!: Table<OfflineCategoryState>;

  constructor() {
    super('AyraOfflineDB');
    this.version(2).stores({
      pending_uploads: '++id, localId, status, timestamp',
      pending_api_calls: '++id, status, timestamp, dependsOnUploadId',
      upload_mappings: 'localId, timestamp'
    });
    this.version(3).stores({
      pending_uploads: '++id, localId, status, timestamp, accountKey, [accountKey+status]',
      pending_api_calls: '++id, status, timestamp, dependsOnUploadId, accountKey, [accountKey+status]',
      upload_mappings: 'localId, timestamp, accountKey',
      sync_leases: 'name, expiresAt, accountKey',
      offline_category_states: 'key, routeId, categoryId, accountKey, updatedAt, [routeId+categoryId]'
    });
  }
}

export const db = new OfflineDatabase();
