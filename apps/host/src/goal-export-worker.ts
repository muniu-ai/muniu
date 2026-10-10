// SPDX-License-Identifier: Apache-2.0
import {writeGoalExport} from './goal-export-writer.js';
import {EXPORT_MAX_BYTES} from './goal-export-renderer-types.js';
async function main():Promise<void>{
 const chunks:Buffer[]=[];let size=0;for await(const chunk of process.stdin){size+=chunk.length;if(size>2*1024*1024)throw Object.assign(new Error(),{code:'EXPORT_LIMIT'});chunks.push(chunk);}
 const bytes=Buffer.concat(chunks);let input;try{input=JSON.parse(bytes.toString('utf8'));}finally{bytes.fill(0);for(const chunk of chunks)chunk.fill(0);}
 const result=await writeGoalExport(input.format,input.document,process.argv[2]!);if(result.length>EXPORT_MAX_BYTES)throw Object.assign(new Error(),{code:'EXPORT_LIMIT'});
 process.stdout.write(JSON.stringify({bytesBase64:Buffer.from(result).toString('base64')}));result.fill(0);
}
main().catch(error=>{process.stdout.write(JSON.stringify({error:{code:typeof error?.code==='string' && /^EXPORT_[A-Z_]+$/.test(error.code)?error.code:'EXPORT_RENDER_FAILED'}}));});
