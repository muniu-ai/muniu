// SPDX-License-Identifier: Apache-2.0
export function createGoalExportSchema() {
  return {type:'object',additionalProperties:false,required:['workspaceId','expectedStreamVersion','planRevisionId','deliverySetId','outputKey','outputDigest','format'],properties:{
    workspaceId:{type:'string',minLength:1,maxLength:200},expectedStreamVersion:{const:0},planRevisionId:{type:'string',minLength:1,maxLength:200},
    deliverySetId:{type:'string',minLength:1,maxLength:200},outputKey:{type:'string',minLength:1,maxLength:200},outputDigest:{type:'string',pattern:'^[a-f0-9]{64}$'},format:{enum:['docx','pdf','xlsx']},
  }};
}
