// SPDX-License-Identifier: Apache-2.0
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export function verifyLargeExportAsset(relativePath,bytes,directory=join(root,'apps/host/assets/fonts/noto-sans-cjk')) {
 if(relativePath!=='apps/host/assets/fonts/noto-sans-cjk/NotoSansCJKsc-Regular.otf'||bytes.length!==16437364||createHash('sha256').update(bytes).digest('hex')!=='2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b')return false;
 verifyExportFont(directory);
 return true;
}
export function verifyExportFont(directory=join(root,'apps/host/assets/fonts/noto-sans-cjk')) {
 const manifest=JSON.parse(readFileSync(join(directory,'manifest.json'),'utf8'));
 if(manifest.repository!=='https://github.com/notofonts/noto-cjk'||manifest.commit!=='523d033d6cb47f4a80c58a35753646f5c3608a78'||manifest.upstreamPath!=='Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf'||manifest.file!=='NotoSansCJKsc-Regular.otf'||manifest.license!=='OFL-1.1'||manifest.licenseFile!=='OFL.txt')throw Error('Export font provenance mismatch');
 const font=readFileSync(join(directory,manifest.file)),license=readFileSync(join(directory,manifest.licenseFile)),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
 if(font.length!==16437364||manifest.byteLength!==font.length||manifest.sha256!=='2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b'||sha(font)!==manifest.sha256||manifest.licenseSha256!=='6a73f9541c2de74158c0e7cf6b0a58ef774f5a780bf191f2d7ec9cc53efe2bf2'||sha(license)!==manifest.licenseSha256)throw Error('Export font or license digest mismatch');
 return manifest;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){verifyExportFont();process.stdout.write('导出字体来源、文件与 OFL 许可校验通过\n');}
