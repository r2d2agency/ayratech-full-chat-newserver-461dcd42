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
  // If this API call depends on an upload, store the localId of that upload
  dependsOnUploadId?: string;
}

export interface UploadMapping {
  localId: string;
  serverUrl: string;
  timestamp: number;
}

export class OfflineDatabase extends Dexie {
  pending_uploads!: Table<PendingUpload>;
  pending_api_calls!: Table<PendingApiCall>;
  upload_mappings!: Table<UploadMapping>;

  constructor() {
    super('AyraOfflineDB');
    this.version(2).stores({
      pending_uploads: '++id, localId, status, timestamp',
      pending_api_calls: '++id, status, timestamp, dependsOnUploadId',
      upload_mappings: 'localId, timestamp'
    });
  }
}

export const db = new OfflineDatabase();
