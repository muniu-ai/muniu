// SPDX-License-Identifier: Apache-2.0
import { createRoot } from 'react-dom/client';
import { EnterpriseApp, type DownloadRequest } from '@mn/product-ui';
import '@mn/product-ui/styles.css';
import brandLogoUrl from './assets/muniu-logo.png';

async function download(request: DownloadRequest): Promise<void> {
  if (request.bytesBase64.length > Math.ceil(20 * 1024 * 1024 * 4 / 3) + 4) throw new Error('导出文件超过允许大小');
  let binary: string;
  try { binary = atob(request.bytesBase64); } catch { throw new Error('导出文件内容无效，请重新导出'); }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  const url = URL.createObjectURL(new Blob([bytes], { type: request.mediaType }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = request.fileName; anchor.rel = 'noopener';
  document.body.append(anchor); anchor.click(); anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const root = document.getElementById('root');
if (!root) throw new Error('应用容器不存在');
createRoot(root).render(<EnterpriseApp origin={window.location.origin} brandLogoUrl={brandLogoUrl} download={download} />);
