// SPDX-License-Identifier: Apache-2.0
import type { JsonObject } from './json.js';
const text={type:'string'},date={type:'string',format:'date'},count={type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER};
const ref={$ref:'#/components/schemas/BusinessObjectRef'};
const object=(properties:Record<string,JsonObject>):JsonObject=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const list=(items:JsonObject):JsonObject=>({type:'array',items});
const view=(properties:Record<string,JsonObject>)=>object({reference:ref,values:object(properties)});
export const ENTERPRISE_BUSINESS_QUERY_SCHEMAS={
 EnterpriseOrderBalance:view({orderId:text,totalMinor:count,grossReceivedMinor:count,refundedMinor:count,reversedMinor:count,netReceivedMinor:count,allocatedMinor:count,unallocatedMinor:count,writtenOffMinor:count,outstandingMinor:count,dueMinor:count,
  periods:list(object({id:text,dueDate:date,amountMinor:count,allocatedMinor:count,writtenOffMinor:count,outstandingMinor:count}))}),
 EnterpriseProjectProgress:view({project:ref,status:text,lines:list(object({lineId:text,promised:count,delivered:count,internallyReceived:count,accepted:count,remaining:count}))}),
 EnterpriseProjectCosts:view({costsComplete:{type:'boolean'},confirmedCostMinor:count,marginMinor:{oneOf:[{...count,minimum:-Number.MAX_SAFE_INTEGER},{const:null}]},marginBasis:{const:'order_value_minus_confirmed_cost'}}),
} as const satisfies Record<string,JsonObject>;
