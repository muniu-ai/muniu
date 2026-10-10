// Generated from api-outputs.ts. Do not edit.
// SPDX-License-Identifier: Apache-2.0
import type { JsonObject } from "./json.js";
export const API_OUTPUT_SCHEMAS_V2: Readonly<Record<string, JsonObject>> = {
  "getBusinessContext": {
    "$ref": "#/components/schemas/OutputBusinessObjectContextV2"
  },
  "getOpcBusiness": {
    "$ref": "#/components/schemas/OutputBusinessManagementViewV1"
  },
  "commandOpcBusiness": {
    "$ref": "#/components/schemas/OutputBusinessManagementViewV1"
  },
  "listGoals": {
    "type": "array",
    "items": {
      "$ref": "#/components/schemas/OutputGoalV2"
    }
  },
  "createGoal": {
    "$ref": "#/components/schemas/OutputGoalDetailV2"
  },
  "getGoal": {
    "$ref": "#/components/schemas/OutputGoalResponseV2"
  },
  "proposeGoalPlan": {
    "$ref": "#/components/schemas/OutputGoalResponseV2"
  },
  "commandGoal": {
    "$ref": "#/components/schemas/OutputGoalResponseV2"
  },
  "acceptGoalDelivery": {
    "$ref": "#/components/schemas/OutputGoalResponseV2"
  },
  "decideGoalDelivery": {
    "$ref": "#/components/schemas/OutputGoalResponseV2"
  },
  "previewGoalRework": {
    "$ref": "#/components/schemas/OutputGoalReworkPreviewV2"
  },
  "reworkGoal": {
    "$ref": "#/components/schemas/OutputGoalResponseV2"
  },
  "listOpcBusinessCandidates": {
    "$ref": "#/components/schemas/OutputOpcBusinessCandidateListV2"
  },
  "createOpcBusinessCandidate": {
    "$ref": "#/components/schemas/OutputOpcBusinessCandidateDetailV2"
  },
  "getOpcBusinessCandidate": {
    "$ref": "#/components/schemas/OutputOpcBusinessCandidateDetailV2"
  },
  "decideOpcBusinessCandidate": {
    "$ref": "#/components/schemas/OutputOpcBusinessCandidateDetailV2"
  },
  "listTeamTemplates": {
    "type": "array",
    "items": {
      "$ref": "#/components/schemas/OutputTeamTemplateSummaryV1"
    }
  },
  "getGoalNodes": {
    "$ref": "#/components/schemas/OutputGoalTeamProgressV2"
  },
  "createBusinessAction": {
    "$ref": "#/components/schemas/OutputBusinessActionV1"
  },
  "getBusinessAction": {
    "$ref": "#/components/schemas/OutputBusinessActionV1"
  },
  "reconcileBusinessAction": {
    "$ref": "#/components/schemas/OutputBusinessActionV1"
  },
  "getBusinessExecutionAuthority": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "allowed",
      "actionDigest",
      "expiresAt",
      "leaseExpiresAt",
      "actionId",
      "operationKey"
    ],
    "properties": {
      "allowed": {
        "type": "boolean",
        "const": true
      },
      "actionDigest": {
        "type": "string"
      },
      "expiresAt": {
        "type": "string"
      },
      "leaseExpiresAt": {
        "type": "string"
      },
      "actionId": {
        "type": "string"
      },
      "operationKey": {
        "type": "string"
      }
    }
  },
  "createBusinessCandidate": {
    "$ref": "#/components/schemas/OutputBusinessCandidateV1"
  },
  "getBusinessCandidate": {
    "$ref": "#/components/schemas/OutputBusinessCandidateV1"
  },
  "getBusinessCandidateContent": {
    "$ref": "#/components/schemas/OutputBusinessCandidateContentV1"
  },
  "runPluginCommand": {
    "$ref": "#/components/schemas/OutputJsonValue"
  },
  "getPluginSurfaces": {
    "type": "array",
    "items": {
      "$ref": "#/components/schemas/OutputWorkspacePluginSurfaceV1"
    }
  },
  "listPluginCatalog": {
    "type": "array",
    "items": {
      "$ref": "#/components/schemas/OutputPluginCatalogItemV2"
    }
  },
  "getOpenApi": {
    "$ref": "#/components/schemas/OutputJsonObject"
  },
  "getHealth": {
    "$ref": "#/components/schemas/OutputHostHealthV2"
  },
  "getReadiness": {
    "$ref": "#/components/schemas/OutputReadinessV2"
  },
  "setup": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "tenantId",
      "principalId"
    ],
    "properties": {
      "tenantId": {
        "type": "string"
      },
      "principalId": {
        "type": "string"
      }
    }
  },
  "listWorkspaces": {
    "type": "array",
    "items": {
      "$ref": "#/components/schemas/OutputWorkspace"
    }
  },
  "createWorkspace": {
    "$ref": "#/components/schemas/OutputWorkspace"
  },
  "getWorkspace": {
    "$ref": "#/components/schemas/OutputWorkspace"
  },
  "updateWorkspace": {
    "$ref": "#/components/schemas/OutputWorkspace"
  },
  "listWorkspaceMembers": {
    "type": "array",
    "items": {
      "$ref": "#/components/schemas/OutputWorkspaceMembership"
    }
  },
  "setWorkspaceMember": {
    "$ref": "#/components/schemas/OutputWorkspaceMembership"
  },
  "removeWorkspaceMember": {
    "$ref": "#/components/schemas/OutputWorkspaceMembership"
  },
  "getWorkspaceAgentCatalog": {
    "$ref": "#/components/schemas/OutputAgentCatalogV2"
  },
  "getWorkspaceHome": {
    "$ref": "#/components/schemas/OutputHomeV2"
  },
  "listThreads": {
    "type": "array",
    "items": {
      "$ref": "#/components/schemas/OutputThread"
    }
  },
  "createThread": {
    "$ref": "#/components/schemas/OutputThread"
  },
  "listThreadTurns": {
    "$ref": "#/components/schemas/OutputThreadTurnsView"
  },
  "createTurn": {
    "$ref": "#/components/schemas/OutputExecution"
  },
  "streamWorkspaceEvents": {
    "type": "string"
  },
  "commandExecution": {
    "$ref": "#/components/schemas/OutputExecution"
  },
  "listInbox": {
    "type": "array",
    "items": {
      "$ref": "#/components/schemas/OutputInboxItemV2"
    }
  },
  "retryKeyRevocation": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "status",
      "streamVersion"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "status": {
        "anyOf": [
          {
            "type": "string",
            "const": "running"
          },
          {
            "type": "string",
            "const": "needs_reconciliation"
          },
          {
            "type": "string",
            "const": "completed"
          },
          {
            "type": "string",
            "const": "pending"
          }
        ]
      },
      "streamVersion": {
        "type": "number"
      }
    }
  },
  "listActivity": {
    "type": "array",
    "items": {
      "$ref": "#/components/schemas/OutputActivityV2"
    }
  },
  "decideApproval": {
    "$ref": "#/components/schemas/OutputApproval"
  },
  "listDeliverables": {
    "type": "array",
    "items": {
      "$ref": "#/components/schemas/OutputDeliverableSummaryV2"
    }
  },
  "createAssets": {
    "type": "array",
    "items": {
      "$ref": "#/components/schemas/OutputAsset"
    }
  },
  "getAsset": {
    "$ref": "#/components/schemas/OutputAsset"
  },
  "getAssetExtraction": {
    "$ref": "#/components/schemas/OutputAssetExtractionV2"
  },
  "downloadAsset": {
    "type": "string",
    "format": "binary"
  },
  "deleteAsset": {
    "$ref": "#/components/schemas/OutputAssetTombstone"
  },
  "listMemories": {
    "type": "array",
    "items": {
      "$ref": "#/components/schemas/OutputMemorySummaryV2"
    }
  },
  "proposeMemory": {
    "$ref": "#/components/schemas/OutputMemoryViewV2"
  },
  "reviseMemoryProposal": {
    "$ref": "#/components/schemas/OutputMemoryViewV2"
  },
  "deleteMemory": {
    "$ref": "#/components/schemas/OutputMemoryTombstone"
  },
  "decideMemory": {
    "$ref": "#/components/schemas/OutputMemoryViewV2"
  },
  "listShareGrants": {
    "type": "array",
    "items": {
      "$ref": "#/components/schemas/OutputShareGrant"
    }
  },
  "createShareGrant": {
    "$ref": "#/components/schemas/OutputShareGrant"
  },
  "revokeShareGrant": {
    "$ref": "#/components/schemas/OutputShareGrant"
  },
  "listModelPresets": {
    "type": "array",
    "items": {
      "$ref": "#/components/schemas/OutputModelPresetV2"
    }
  },
  "listModelConnections": {
    "type": "array",
    "items": {
      "$ref": "#/components/schemas/OutputModelConnectionV2"
    }
  },
  "createModelConnection": {
    "$ref": "#/components/schemas/OutputModelConnectionV2"
  },
  "probeModelConnection": {
    "$ref": "#/components/schemas/OutputModelConnectionV2"
  },
  "selectModelConnectionModel": {
    "$ref": "#/components/schemas/OutputModelConnectionV2"
  },
  "getWorkspaceAgentReadiness": {
    "$ref": "#/components/schemas/OutputAgentReadinessReportV1"
  },
  "installPlugin": {
    "$ref": "#/components/schemas/OutputPluginInstallation"
  },
  "listPluginInstallations": {
    "type": "array",
    "items": {
      "anyOf": [
        {
          "$ref": "#/components/schemas/OutputPluginInstallation"
        },
        {
          "$ref": "#/components/schemas/OutputOfficialPluginV2"
        }
      ]
    }
  },
  "updatePlugin": {
    "$ref": "#/components/schemas/OutputPluginInstallation"
  },
  "disablePlugin": {
    "$ref": "#/components/schemas/OutputPluginInstallation"
  },
  "purgePlugin": {
    "$ref": "#/components/schemas/OutputPluginPurgeResult"
  },
  "activatePlugin": {
    "$ref": "#/components/schemas/OutputWorkspace"
  },
  "deactivatePlugin": {
    "$ref": "#/components/schemas/OutputWorkspace"
  },
  "listOpcOpportunities": {
    "type": "array",
    "items": {
      "$ref": "#/components/schemas/OutputOpportunitySummaryV2"
    }
  },
  "createOpcOpportunity": {
    "$ref": "#/components/schemas/OutputOpportunityAggregate"
  },
  "getOpcOpportunity": {
    "$ref": "#/components/schemas/OutputOpportunityViewV2"
  },
  "commandOpcOpportunity": {
    "$ref": "#/components/schemas/OutputOpportunityViewV2"
  },
  "previewOpcDeliverables": {
    "type": "array",
    "items": {
      "$ref": "#/components/schemas/OutputOpcDeliverableV2"
    }
  },
  "exportOpcDeliverables": {
    "type": "array",
    "items": {
      "$ref": "#/components/schemas/OutputStoredOpcDeliverableV2"
    }
  },
  "runOpcReadOnlySample": {
    "$ref": "#/components/schemas/OutputReadOnlySampleV2"
  },
  "createCodingRepository": {
    "$ref": "#/components/schemas/OutputCodingRepositoryV2"
  },
  "listCodingRepositories": {
    "type": "array",
    "items": {
      "$ref": "#/components/schemas/OutputCodingRepositoryV2"
    }
  },
  "listCodingTasks": {
    "type": "array",
    "items": {
      "$ref": "#/components/schemas/OutputCodingTaskSummaryV2"
    }
  },
  "createCodingTask": {
    "$ref": "#/components/schemas/OutputCodingTaskV2"
  },
  "runCodingReadOnlySample": {
    "$ref": "#/components/schemas/OutputReadOnlySampleV2"
  },
  "listCodingRunners": {
    "type": "array",
    "items": {
      "$ref": "#/components/schemas/OutputCodingRunnerViewV2"
    }
  },
  "inspectCodingRunner": {
    "$ref": "#/components/schemas/OutputRunnerBinaryInspectionV1"
  },
  "confirmCodingRunner": {
    "$ref": "#/components/schemas/OutputCodingRunnerConfigurationV1"
  },
  "getCodingReconciliation": {
    "$ref": "#/components/schemas/OutputCodingReconciliationViewV2"
  },
  "decideCodingReconciliation": {
    "$ref": "#/components/schemas/OutputCodingReconciliationResultV2"
  }
};
export const API_OUTPUT_COMPONENTS_V2: Readonly<Record<string, JsonObject>> = {
  "OutputJsonValue": {
    "anyOf": [
      {
        "type": "null"
      },
      {
        "type": "boolean"
      },
      {
        "type": "number"
      },
      {
        "type": "string"
      },
      {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputJsonValue"
        }
      },
      {
        "type": "object",
        "additionalProperties": {
          "$ref": "#/components/schemas/OutputJsonValue"
        }
      }
    ]
  },
  "OutputJsonObject": {
    "type": "object",
    "additionalProperties": {
      "$ref": "#/components/schemas/OutputJsonValue"
    }
  },
  "OutputGoalResourceRefV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "streamVersion",
      "namespace",
      "resourceId"
    ],
    "properties": {
      "streamVersion": {
        "type": "number"
      },
      "namespace": {
        "type": "string"
      },
      "resourceId": {
        "type": "string"
      },
      "digest": {
        "type": "string"
      }
    }
  },
  "OutputBusinessObjectContextV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "title",
      "sourceRef",
      "content",
      "kind",
      "resourceId"
    ],
    "properties": {
      "title": {
        "type": "string"
      },
      "sourceRef": {
        "$ref": "#/components/schemas/OutputGoalResourceRefV2"
      },
      "content": {
        "type": "string"
      },
      "kind": {
        "anyOf": [
          {
            "type": "string",
            "const": "service"
          },
          {
            "type": "string",
            "const": "review"
          },
          {
            "type": "string",
            "const": "quote"
          },
          {
            "type": "string",
            "const": "customer"
          },
          {
            "type": "string",
            "const": "order"
          },
          {
            "type": "string",
            "const": "delivery"
          }
        ]
      },
      "resourceId": {
        "type": "string"
      }
    }
  },
  "OutputBusinessPeriodV1": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "start",
      "end"
    ],
    "properties": {
      "start": {
        "type": "string"
      },
      "end": {
        "type": "string"
      }
    }
  },
  "OutputBusinessPlanV1": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "revision",
      "title",
      "period",
      "targetCustomer",
      "valueProposition",
      "focus",
      "resources",
      "reviewOn",
      "recordedBy",
      "recordedAt"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "revision": {
        "type": "number"
      },
      "title": {
        "type": "string"
      },
      "period": {
        "$ref": "#/components/schemas/OutputBusinessPeriodV1"
      },
      "targetCustomer": {
        "type": "string"
      },
      "valueProposition": {
        "type": "string"
      },
      "focus": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "resources": {
        "type": "string"
      },
      "reviewOn": {
        "type": "string"
      },
      "recordedBy": {
        "type": "string"
      },
      "recordedAt": {
        "type": "string"
      }
    }
  },
  "OutputBusinessCustomerV1": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "version",
      "name",
      "source",
      "need",
      "recordedBy",
      "recordedAt"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "version": {
        "type": "number"
      },
      "name": {
        "type": "string"
      },
      "source": {
        "type": "string"
      },
      "need": {
        "type": "string"
      },
      "contact": {
        "type": "string"
      },
      "followUpOn": {
        "type": "string"
      },
      "recordedBy": {
        "type": "string"
      },
      "recordedAt": {
        "type": "string"
      }
    }
  },
  "OutputBusinessServiceV1": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "version",
      "title",
      "currency",
      "priceMinor",
      "inScope",
      "outOfScope",
      "acceptanceCriteria",
      "recordedBy",
      "recordedAt"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "version": {
        "type": "number"
      },
      "title": {
        "type": "string"
      },
      "currency": {
        "type": "string",
        "const": "CNY"
      },
      "priceMinor": {
        "type": "string"
      },
      "inScope": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "outOfScope": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "acceptanceCriteria": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "recordedBy": {
        "type": "string"
      },
      "recordedAt": {
        "type": "string"
      }
    }
  },
  "OutputBusinessQuoteV1": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "customerId",
      "customerVersion",
      "serviceId",
      "serviceVersion",
      "quantity",
      "discountMinor",
      "totalMinor",
      "validUntil",
      "dueOn",
      "recordedBy",
      "recordedAt"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "customerId": {
        "type": "string"
      },
      "customerVersion": {
        "type": "number"
      },
      "serviceId": {
        "type": "string"
      },
      "serviceVersion": {
        "type": "number"
      },
      "quantity": {
        "type": "number"
      },
      "discountMinor": {
        "type": "string"
      },
      "totalMinor": {
        "type": "string"
      },
      "validUntil": {
        "type": "string"
      },
      "dueOn": {
        "type": "string"
      },
      "notes": {
        "type": "string"
      },
      "recordedBy": {
        "type": "string"
      },
      "recordedAt": {
        "type": "string"
      }
    }
  },
  "OutputBusinessQuoteConfirmationV1": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "quoteId",
      "confirmedOn",
      "sourceRef",
      "recordedBy",
      "recordedAt"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "quoteId": {
        "type": "string"
      },
      "confirmedOn": {
        "type": "string"
      },
      "sourceRef": {
        "type": "string"
      },
      "recordedBy": {
        "type": "string"
      },
      "recordedAt": {
        "type": "string"
      }
    }
  },
  "OutputBusinessOpeningV1": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "asOf",
      "receivedMinor",
      "deliveredPercent",
      "accepted",
      "sourceRef"
    ],
    "properties": {
      "asOf": {
        "type": "string"
      },
      "receivedMinor": {
        "type": "string"
      },
      "deliveredPercent": {
        "type": "number"
      },
      "accepted": {
        "anyOf": [
          {
            "type": "boolean",
            "const": false
          },
          {
            "type": "boolean",
            "const": true
          }
        ]
      },
      "sourceRef": {
        "type": "string"
      }
    }
  },
  "OutputBusinessOrderV1": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "customerId",
      "customerVersion",
      "serviceId",
      "serviceVersion",
      "quantity",
      "agreedAmountMinor",
      "contractedOn",
      "dueOn",
      "sourceRef",
      "recordedBy",
      "recordedAt"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "customerId": {
        "type": "string"
      },
      "customerVersion": {
        "type": "number"
      },
      "serviceId": {
        "type": "string"
      },
      "serviceVersion": {
        "type": "number"
      },
      "quantity": {
        "type": "number"
      },
      "agreedAmountMinor": {
        "type": "string"
      },
      "contractedOn": {
        "type": "string"
      },
      "dueOn": {
        "type": "string"
      },
      "sourceRef": {
        "type": "string"
      },
      "quoteId": {
        "type": "string"
      },
      "quoteConfirmationId": {
        "type": "string"
      },
      "opening": {
        "$ref": "#/components/schemas/OutputBusinessOpeningV1"
      },
      "recordedBy": {
        "type": "string"
      },
      "recordedAt": {
        "type": "string"
      }
    }
  },
  "OutputBusinessOrderAdjustmentV1": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "orderId",
      "amountDeltaMinor",
      "effectiveOn",
      "reason",
      "sourceRef",
      "recordedBy",
      "recordedAt"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "orderId": {
        "type": "string"
      },
      "amountDeltaMinor": {
        "type": "string"
      },
      "effectiveOn": {
        "type": "string"
      },
      "dueOn": {
        "type": "string"
      },
      "reason": {
        "type": "string"
      },
      "sourceRef": {
        "type": "string"
      },
      "recordedBy": {
        "type": "string"
      },
      "recordedAt": {
        "type": "string"
      }
    }
  },
  "OutputBusinessDeliveryV1": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "orderId",
      "title",
      "deliveredOn",
      "artifactRef",
      "progressPercent",
      "recordedBy",
      "recordedAt"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "orderId": {
        "type": "string"
      },
      "title": {
        "type": "string"
      },
      "deliveredOn": {
        "type": "string"
      },
      "artifactRef": {
        "type": "string"
      },
      "progressPercent": {
        "type": "number"
      },
      "notes": {
        "type": "string"
      },
      "recordedBy": {
        "type": "string"
      },
      "recordedAt": {
        "type": "string"
      }
    }
  },
  "OutputBusinessAcceptanceV1": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "orderId",
      "deliveryIds",
      "acceptedOn",
      "customerConfirmationRef",
      "complete",
      "recordedBy",
      "recordedAt"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "orderId": {
        "type": "string"
      },
      "deliveryIds": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "acceptedOn": {
        "type": "string"
      },
      "customerConfirmationRef": {
        "type": "string"
      },
      "complete": {
        "anyOf": [
          {
            "type": "boolean",
            "const": false
          },
          {
            "type": "boolean",
            "const": true
          }
        ]
      },
      "recordedBy": {
        "type": "string"
      },
      "recordedAt": {
        "type": "string"
      }
    }
  },
  "OutputBusinessPaymentV1": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "orderId",
      "amountMinor",
      "receivedOn",
      "sourceRef",
      "recordedBy",
      "recordedAt"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "orderId": {
        "type": "string"
      },
      "amountMinor": {
        "type": "string"
      },
      "receivedOn": {
        "type": "string"
      },
      "sourceRef": {
        "type": "string"
      },
      "recordedBy": {
        "type": "string"
      },
      "recordedAt": {
        "type": "string"
      }
    }
  },
  "OutputBusinessPaymentReversalV1": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "paymentId",
      "reversedOn",
      "reason",
      "sourceRef",
      "recordedBy",
      "recordedAt"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "paymentId": {
        "type": "string"
      },
      "reversedOn": {
        "type": "string"
      },
      "reason": {
        "type": "string"
      },
      "sourceRef": {
        "type": "string"
      },
      "recordedBy": {
        "type": "string"
      },
      "recordedAt": {
        "type": "string"
      }
    }
  },
  "OutputBusinessRefundV1": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "orderId",
      "amountMinor",
      "refundedOn",
      "reason",
      "sourceRef",
      "recordedBy",
      "recordedAt"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "orderId": {
        "type": "string"
      },
      "paymentId": {
        "type": "string"
      },
      "amountMinor": {
        "type": "string"
      },
      "refundedOn": {
        "type": "string"
      },
      "reason": {
        "type": "string"
      },
      "sourceRef": {
        "type": "string"
      },
      "recordedBy": {
        "type": "string"
      },
      "recordedAt": {
        "type": "string"
      }
    }
  },
  "OutputBusinessExpenseV1": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "category",
      "description",
      "amountMinor",
      "paidOn",
      "sourceRef",
      "recordedBy",
      "recordedAt"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "orderId": {
        "type": "string"
      },
      "category": {
        "type": "string"
      },
      "description": {
        "type": "string"
      },
      "amountMinor": {
        "type": "string"
      },
      "paidOn": {
        "type": "string"
      },
      "sourceRef": {
        "type": "string"
      },
      "recordedBy": {
        "type": "string"
      },
      "recordedAt": {
        "type": "string"
      }
    }
  },
  "OutputBusinessOrderBalanceV1": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "orderId",
      "agreedAmountMinor",
      "receivedMinor",
      "refundedMinor",
      "netReceivedMinor",
      "outstandingMinor",
      "dueOn",
      "overdue",
      "delivered",
      "deliveredPercent",
      "accepted"
    ],
    "properties": {
      "orderId": {
        "type": "string"
      },
      "agreedAmountMinor": {
        "type": "string"
      },
      "receivedMinor": {
        "type": "string"
      },
      "refundedMinor": {
        "type": "string"
      },
      "netReceivedMinor": {
        "type": "string"
      },
      "outstandingMinor": {
        "type": "string"
      },
      "dueOn": {
        "type": "string"
      },
      "overdue": {
        "anyOf": [
          {
            "type": "boolean",
            "const": false
          },
          {
            "type": "boolean",
            "const": true
          }
        ]
      },
      "delivered": {
        "anyOf": [
          {
            "type": "boolean",
            "const": false
          },
          {
            "type": "boolean",
            "const": true
          }
        ]
      },
      "deliveredPercent": {
        "type": "number"
      },
      "accepted": {
        "anyOf": [
          {
            "type": "boolean",
            "const": false
          },
          {
            "type": "boolean",
            "const": true
          }
        ]
      }
    }
  },
  "OutputBusinessSummaryV1": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "currency",
      "sourceStreamVersion",
      "cashReceivedMinor",
      "cashRefundedMinor",
      "cashExpensesMinor",
      "netCashFlowMinor",
      "contractedMinor",
      "outstandingMinor",
      "overdueMinor",
      "orders"
    ],
    "properties": {
      "currency": {
        "type": "string",
        "const": "CNY"
      },
      "period": {
        "$ref": "#/components/schemas/OutputBusinessPeriodV1"
      },
      "sourceStreamVersion": {
        "type": "number"
      },
      "cashReceivedMinor": {
        "type": "string"
      },
      "cashRefundedMinor": {
        "type": "string"
      },
      "cashExpensesMinor": {
        "type": "string"
      },
      "netCashFlowMinor": {
        "type": "string"
      },
      "contractedMinor": {
        "type": "string"
      },
      "outstandingMinor": {
        "type": "string"
      },
      "overdueMinor": {
        "type": "string"
      },
      "orders": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputBusinessOrderBalanceV1"
        }
      }
    }
  },
  "OutputBusinessReviewV1": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "period",
      "sourceStreamVersion",
      "summary",
      "explanation",
      "nextDecisions",
      "recordedBy",
      "recordedAt"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "period": {
        "$ref": "#/components/schemas/OutputBusinessPeriodV1"
      },
      "sourceStreamVersion": {
        "type": "number"
      },
      "summary": {
        "$ref": "#/components/schemas/OutputBusinessSummaryV1"
      },
      "explanation": {
        "type": "string"
      },
      "nextDecisions": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "recordedBy": {
        "type": "string"
      },
      "recordedAt": {
        "type": "string"
      }
    }
  },
  "OutputBusinessStateV1": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schemaVersion",
      "workspaceId",
      "currency",
      "streamVersion",
      "plans",
      "customers",
      "services",
      "quotes",
      "orders",
      "adjustments",
      "deliveries",
      "acceptances",
      "payments",
      "paymentReversals",
      "refunds",
      "expenses",
      "reviews"
    ],
    "properties": {
      "schemaVersion": {
        "type": "number",
        "const": 1
      },
      "workspaceId": {
        "type": "string"
      },
      "currency": {
        "type": "string",
        "const": "CNY"
      },
      "streamVersion": {
        "type": "number"
      },
      "plans": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputBusinessPlanV1"
        }
      },
      "customers": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputBusinessCustomerV1"
        }
      },
      "services": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputBusinessServiceV1"
        }
      },
      "quotes": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputBusinessQuoteV1"
        }
      },
      "quoteConfirmations": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputBusinessQuoteConfirmationV1"
        }
      },
      "orders": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputBusinessOrderV1"
        }
      },
      "adjustments": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputBusinessOrderAdjustmentV1"
        }
      },
      "deliveries": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputBusinessDeliveryV1"
        }
      },
      "acceptances": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputBusinessAcceptanceV1"
        }
      },
      "payments": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputBusinessPaymentV1"
        }
      },
      "paymentReversals": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputBusinessPaymentReversalV1"
        }
      },
      "refunds": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputBusinessRefundV1"
        }
      },
      "expenses": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputBusinessExpenseV1"
        }
      },
      "reviews": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputBusinessReviewV1"
        }
      }
    }
  },
  "OutputBusinessManagementViewV1": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "state",
      "summary"
    ],
    "properties": {
      "state": {
        "$ref": "#/components/schemas/OutputBusinessStateV1"
      },
      "summary": {
        "$ref": "#/components/schemas/OutputBusinessSummaryV1"
      }
    }
  },
  "OutputGoalDeliverableSpecV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "key",
      "title",
      "required",
      "criteria"
    ],
    "properties": {
      "key": {
        "type": "string"
      },
      "title": {
        "type": "string"
      },
      "required": {
        "anyOf": [
          {
            "type": "boolean",
            "const": false
          },
          {
            "type": "boolean",
            "const": true
          }
        ]
      },
      "criteria": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "id",
            "description"
          ],
          "properties": {
            "id": {
              "type": "string"
            },
            "description": {
              "type": "string"
            }
          }
        }
      }
    }
  },
  "OutputGoalBudgetV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "maxTokens",
      "maxCostMinorUnits",
      "currency",
      "maxDurationMs"
    ],
    "properties": {
      "maxTokens": {
        "type": "number"
      },
      "maxCostMinorUnits": {
        "type": "string"
      },
      "currency": {
        "type": "string"
      },
      "maxDurationMs": {
        "type": "number"
      }
    }
  },
  "OutputGoalStatusV2": {
    "anyOf": [
      {
        "type": "string",
        "const": "running"
      },
      {
        "type": "string",
        "const": "waiting_approval"
      },
      {
        "type": "string",
        "const": "paused"
      },
      {
        "type": "string",
        "const": "needs_reconciliation"
      },
      {
        "type": "string",
        "const": "failed"
      },
      {
        "type": "string",
        "const": "cancelled"
      },
      {
        "type": "string",
        "const": "accepted"
      },
      {
        "type": "string",
        "const": "draft"
      },
      {
        "type": "string",
        "const": "awaiting_authorization"
      },
      {
        "type": "string",
        "const": "pausing"
      },
      {
        "type": "string",
        "const": "awaiting_acceptance"
      }
    ]
  },
  "OutputGoalExecutionRefV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "executionId",
      "threadId",
      "planRevisionId",
      "generation"
    ],
    "properties": {
      "executionId": {
        "type": "string"
      },
      "threadId": {
        "type": "string"
      },
      "planRevisionId": {
        "type": "string"
      },
      "generation": {
        "type": "number"
      }
    }
  },
  "OutputGoalUsageV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "tokens",
      "costMinorUnits",
      "currency"
    ],
    "properties": {
      "tokens": {
        "type": "number"
      },
      "costMinorUnits": {
        "type": "string"
      },
      "currency": {
        "type": "string"
      }
    }
  },
  "OutputGoalV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "tenantId",
      "workspaceId",
      "principalId",
      "threadId",
      "objective",
      "inputVersion",
      "criteriaVersion",
      "deliverables",
      "resourceRefs",
      "budget",
      "status",
      "streamVersion",
      "createdAt",
      "updatedAt"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "tenantId": {
        "type": "string"
      },
      "workspaceId": {
        "type": "string"
      },
      "principalId": {
        "type": "string"
      },
      "threadId": {
        "type": "string"
      },
      "objective": {
        "type": "string"
      },
      "inputVersion": {
        "type": "number"
      },
      "criteriaVersion": {
        "type": "string"
      },
      "deliverables": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputGoalDeliverableSpecV2"
        }
      },
      "resourceRefs": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputGoalResourceRefV2"
        }
      },
      "budget": {
        "$ref": "#/components/schemas/OutputGoalBudgetV2"
      },
      "status": {
        "$ref": "#/components/schemas/OutputGoalStatusV2"
      },
      "streamVersion": {
        "type": "number"
      },
      "createdAt": {
        "type": "string"
      },
      "updatedAt": {
        "type": "string"
      },
      "planRevisionId": {
        "type": "string"
      },
      "executionRef": {
        "$ref": "#/components/schemas/OutputGoalExecutionRefV2"
      },
      "coordinationRef": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "runId",
          "planRevisionId"
        ],
        "properties": {
          "runId": {
            "type": "string"
          },
          "planRevisionId": {
            "type": "string"
          }
        }
      },
      "reservation": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "status"
        ],
        "properties": {
          "status": {
            "anyOf": [
              {
                "type": "string",
                "const": "unknown"
              },
              {
                "type": "string",
                "const": "reserved"
              },
              {
                "type": "string",
                "const": "settled"
              }
            ]
          },
          "actual": {
            "$ref": "#/components/schemas/OutputGoalUsageV2"
          }
        }
      },
      "authorization": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "planDigest",
          "principalId",
          "membershipStreamVersion"
        ],
        "properties": {
          "planDigest": {
            "type": "string"
          },
          "principalId": {
            "type": "string"
          },
          "membershipStreamVersion": {
            "type": "number"
          }
        }
      },
      "deliverySetId": {
        "type": "string"
      },
      "acceptanceId": {
        "type": "string"
      },
      "cancellationRequestedAt": {
        "type": "string"
      },
      "reasonCode": {
        "type": "string"
      }
    }
  },
  "OutputAgentSchedulingRequestV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "runnerId",
      "strategy"
    ],
    "properties": {
      "runnerId": {
        "anyOf": [
          {
            "type": "string",
            "const": "builtin"
          },
          {
            "type": "string",
            "const": "claude-cli"
          },
          {
            "type": "string",
            "const": "codex-cli"
          },
          {
            "type": "string",
            "const": "auto"
          }
        ]
      },
      "strategy": {
        "anyOf": [
          {
            "type": "string",
            "const": "quality"
          },
          {
            "type": "string",
            "const": "balanced"
          },
          {
            "type": "string",
            "const": "cost"
          }
        ]
      },
      "modelBindingId": {
        "type": "string"
      },
      "expectedValueMinorUnits": {
        "type": "string"
      },
      "timeCostMinorUnitsPerHour": {
        "type": "string"
      }
    }
  },
  "OutputAgentSchedulingCandidateV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "label",
      "runnerId",
      "modelBindingId",
      "fingerprint",
      "currency",
      "samples",
      "accepted",
      "qualityLowerBound",
      "evidence",
      "expectedCostMinorUnits",
      "expectedDurationMs",
      "expectedTotalCostMinorUnits",
      "expectedNetValueMinorUnits",
      "roiBasisPoints",
      "eligible",
      "reasons"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "label": {
        "type": "string"
      },
      "runnerId": {
        "anyOf": [
          {
            "type": "string",
            "const": "builtin"
          },
          {
            "type": "string",
            "const": "claude-cli"
          },
          {
            "type": "string",
            "const": "codex-cli"
          }
        ]
      },
      "modelBindingId": {
        "type": "string"
      },
      "fingerprint": {
        "type": "string"
      },
      "currency": {
        "type": "string"
      },
      "samples": {
        "type": "number"
      },
      "accepted": {
        "type": "number"
      },
      "qualityLowerBound": {
        "type": "number"
      },
      "evidence": {
        "anyOf": [
          {
            "type": "string",
            "const": "observed"
          },
          {
            "type": "string",
            "const": "insufficient"
          }
        ]
      },
      "expectedCostMinorUnits": {
        "anyOf": [
          {
            "type": "null"
          },
          {
            "type": "string"
          }
        ]
      },
      "expectedDurationMs": {
        "type": "number"
      },
      "expectedTotalCostMinorUnits": {
        "anyOf": [
          {
            "type": "null"
          },
          {
            "type": "string"
          }
        ]
      },
      "expectedNetValueMinorUnits": {
        "anyOf": [
          {
            "type": "null"
          },
          {
            "type": "string"
          }
        ]
      },
      "roiBasisPoints": {
        "anyOf": [
          {
            "type": "null"
          },
          {
            "type": "number"
          }
        ]
      },
      "eligible": {
        "anyOf": [
          {
            "type": "boolean",
            "const": false
          },
          {
            "type": "boolean",
            "const": true
          }
        ]
      },
      "reasons": {
        "type": "array",
        "items": {
          "type": "string"
        }
      }
    }
  },
  "OutputAgentSchedulingDecisionV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "algorithm",
      "request",
      "selectedId",
      "candidates",
      "taskClass",
      "evidenceDigest"
    ],
    "properties": {
      "algorithm": {
        "type": "string",
        "const": "quality-roi-v1"
      },
      "request": {
        "$ref": "#/components/schemas/OutputAgentSchedulingRequestV2"
      },
      "selectedId": {
        "type": "string"
      },
      "candidates": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputAgentSchedulingCandidateV2"
        }
      },
      "taskClass": {
        "type": "string"
      },
      "evidenceDigest": {
        "type": "string"
      }
    }
  },
  "OutputResourceRef": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "namespace",
      "resourceId"
    ],
    "properties": {
      "namespace": {
        "type": "string"
      },
      "resourceId": {
        "type": "string"
      },
      "digest": {
        "type": "string"
      }
    }
  },
  "OutputToolEffectClass": {
    "anyOf": [
      {
        "type": "string",
        "const": "local_read"
      },
      {
        "type": "string",
        "const": "external_read"
      },
      {
        "type": "string",
        "const": "local_reversible_write"
      },
      {
        "type": "string",
        "const": "local_irreversible_write"
      },
      {
        "type": "string",
        "const": "external_side_effect"
      },
      {
        "type": "string",
        "const": "financial"
      },
      {
        "type": "string",
        "const": "privileged"
      },
      {
        "type": "string",
        "const": "unknown"
      }
    ]
  },
  "OutputGoalPlanRevisionV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "goalId",
      "threadId",
      "revision",
      "inputVersion",
      "criteriaVersion",
      "budget",
      "resourceRefs",
      "deliverables",
      "digest",
      "createdAt",
      "domainInputDigest",
      "threadStreamVersion",
      "pluginId",
      "pluginVersion",
      "agentDefinitionId",
      "modelBindingId",
      "modelConnectionStreamVersion",
      "model",
      "runnerId",
      "toolIds",
      "dataScopes",
      "autoAllowedEffects"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "goalId": {
        "type": "string"
      },
      "threadId": {
        "type": "string"
      },
      "revision": {
        "type": "number"
      },
      "inputVersion": {
        "type": "number"
      },
      "criteriaVersion": {
        "type": "string"
      },
      "budget": {
        "$ref": "#/components/schemas/OutputGoalBudgetV2"
      },
      "resourceRefs": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputGoalResourceRefV2"
        }
      },
      "deliverables": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputGoalDeliverableSpecV2"
        }
      },
      "digest": {
        "type": "string"
      },
      "createdAt": {
        "type": "string"
      },
      "outputFormat": {
        "type": "string",
        "const": "items-v1"
      },
      "domainInputDigest": {
        "type": "string"
      },
      "threadStreamVersion": {
        "type": "number"
      },
      "pluginId": {
        "anyOf": [
          {
            "type": "string",
            "const": "opc"
          },
          {
            "type": "string",
            "const": "coding"
          }
        ]
      },
      "pluginVersion": {
        "type": "string"
      },
      "pluginPackageSha256": {
        "type": "string"
      },
      "agentDefinitionId": {
        "type": "string"
      },
      "modelBindingId": {
        "type": "string"
      },
      "modelConnectionStreamVersion": {
        "type": "number"
      },
      "model": {
        "type": "string"
      },
      "runnerId": {
        "anyOf": [
          {
            "type": "string",
            "const": "builtin"
          },
          {
            "type": "string",
            "const": "claude-cli"
          },
          {
            "type": "string",
            "const": "codex-cli"
          }
        ]
      },
      "runnerBinding": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "configurationStreamVersion",
          "identityDigest"
        ],
        "properties": {
          "configurationStreamVersion": {
            "type": "number"
          },
          "identityDigest": {
            "type": "string"
          }
        }
      },
      "scheduling": {
        "$ref": "#/components/schemas/OutputAgentSchedulingDecisionV2"
      },
      "toolIds": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "dataScopes": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputResourceRef"
        }
      },
      "autoAllowedEffects": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputToolEffectClass"
        }
      }
    }
  },
  "OutputGoalOutputRefV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "key",
      "resourceRef",
      "digest",
      "criteriaVersion",
      "preview",
      "sourceRefs",
      "checks"
    ],
    "properties": {
      "key": {
        "type": "string"
      },
      "resourceRef": {
        "$ref": "#/components/schemas/OutputGoalResourceRefV2"
      },
      "digest": {
        "type": "string"
      },
      "criteriaVersion": {
        "type": "string"
      },
      "preview": {
        "type": "string"
      },
      "sourceRefs": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputGoalResourceRefV2"
        }
      },
      "businessProposals": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "key",
            "title",
            "commandType"
          ],
          "properties": {
            "key": {
              "type": "string"
            },
            "title": {
              "type": "string"
            },
            "commandType": {
              "anyOf": [
                {
                  "type": "string",
                  "const": "quote.create"
                },
                {
                  "type": "string",
                  "const": "delivery.record"
                },
                {
                  "type": "string",
                  "const": "review.record"
                }
              ]
            }
          }
        }
      },
      "checks": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "checkId",
            "status",
            "evidenceRefs"
          ],
          "properties": {
            "checkId": {
              "type": "string"
            },
            "status": {
              "anyOf": [
                {
                  "type": "string",
                  "const": "failed"
                },
                {
                  "type": "string",
                  "const": "passed"
                }
              ]
            },
            "evidenceRefs": {
              "type": "array",
              "items": {
                "$ref": "#/components/schemas/OutputGoalResourceRefV2"
              }
            }
          }
        }
      }
    }
  },
  "OutputGoalDeliverySetV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "goalId",
      "planRevisionId",
      "criteriaVersion",
      "items",
      "digest",
      "createdAt"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "goalId": {
        "type": "string"
      },
      "planRevisionId": {
        "type": "string"
      },
      "criteriaVersion": {
        "type": "string"
      },
      "items": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputGoalOutputRefV2"
        }
      },
      "digest": {
        "type": "string"
      },
      "createdAt": {
        "type": "string"
      }
    }
  },
  "OutputGoalDetailV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "goal",
      "plan",
      "deliverySet"
    ],
    "properties": {
      "goal": {
        "$ref": "#/components/schemas/OutputGoalV2"
      },
      "plan": {
        "anyOf": [
          {
            "type": "null"
          },
          {
            "$ref": "#/components/schemas/OutputGoalPlanRevisionV2"
          }
        ]
      },
      "deliverySet": {
        "anyOf": [
          {
            "type": "null"
          },
          {
            "$ref": "#/components/schemas/OutputGoalDeliverySetV2"
          }
        ]
      }
    }
  },
  "OutputTeamTemplateIdV1": {
    "anyOf": [
      {
        "type": "string",
        "const": "research-summary"
      },
      {
        "type": "string",
        "const": "business-proposal"
      },
      {
        "type": "string",
        "const": "code-delivery"
      }
    ]
  },
  "OutputGoalPlanProposalV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "domainInputDigest",
      "threadStreamVersion",
      "pluginId",
      "pluginVersion",
      "agentDefinitionId",
      "modelBindingId",
      "modelConnectionStreamVersion",
      "model",
      "runnerId",
      "toolIds",
      "dataScopes",
      "autoAllowedEffects"
    ],
    "properties": {
      "outputFormat": {
        "type": "string",
        "const": "items-v1"
      },
      "domainInputDigest": {
        "type": "string"
      },
      "threadStreamVersion": {
        "type": "number"
      },
      "pluginId": {
        "anyOf": [
          {
            "type": "string",
            "const": "opc"
          },
          {
            "type": "string",
            "const": "coding"
          }
        ]
      },
      "pluginVersion": {
        "type": "string"
      },
      "pluginPackageSha256": {
        "type": "string"
      },
      "agentDefinitionId": {
        "type": "string"
      },
      "modelBindingId": {
        "type": "string"
      },
      "modelConnectionStreamVersion": {
        "type": "number"
      },
      "model": {
        "type": "string"
      },
      "runnerId": {
        "anyOf": [
          {
            "type": "string",
            "const": "builtin"
          },
          {
            "type": "string",
            "const": "claude-cli"
          },
          {
            "type": "string",
            "const": "codex-cli"
          }
        ]
      },
      "runnerBinding": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "configurationStreamVersion",
          "identityDigest"
        ],
        "properties": {
          "configurationStreamVersion": {
            "type": "number"
          },
          "identityDigest": {
            "type": "string"
          }
        }
      },
      "scheduling": {
        "$ref": "#/components/schemas/OutputAgentSchedulingDecisionV2"
      },
      "toolIds": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "dataScopes": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputResourceRef"
        }
      },
      "autoAllowedEffects": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputToolEffectClass"
        }
      }
    }
  },
  "OutputTeamCapabilityRefV1": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "version",
      "digest"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "version": {
        "type": "string"
      },
      "digest": {
        "type": "string"
      }
    }
  },
  "OutputTeamNodeInputV1": {
    "anyOf": [
      {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "key",
          "kind"
        ],
        "properties": {
          "key": {
            "type": "string"
          },
          "kind": {
            "type": "string",
            "const": "goal"
          }
        }
      },
      {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "key",
          "kind",
          "resourceRef"
        ],
        "properties": {
          "key": {
            "type": "string"
          },
          "kind": {
            "type": "string",
            "const": "source"
          },
          "resourceRef": {
            "$ref": "#/components/schemas/OutputGoalResourceRefV2"
          }
        }
      },
      {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "key",
          "kind",
          "nodeId",
          "outputKey"
        ],
        "properties": {
          "key": {
            "type": "string"
          },
          "kind": {
            "type": "string",
            "const": "node_output"
          },
          "nodeId": {
            "type": "string"
          },
          "outputKey": {
            "type": "string"
          }
        }
      }
    ]
  },
  "OutputTeamOutputKindV1": {
    "anyOf": [
      {
        "type": "string",
        "const": "analysis"
      },
      {
        "type": "string",
        "const": "artifact"
      },
      {
        "type": "string",
        "const": "evidence"
      },
      {
        "type": "string",
        "const": "self_assessment"
      },
      {
        "type": "string",
        "const": "review"
      },
      {
        "type": "string",
        "const": "decision"
      }
    ]
  },
  "OutputTeamNodeOutputSpecV1": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "key",
      "kind",
      "description"
    ],
    "properties": {
      "key": {
        "type": "string"
      },
      "kind": {
        "$ref": "#/components/schemas/OutputTeamOutputKindV1"
      },
      "description": {
        "type": "string"
      }
    }
  },
  "OutputTeamAgentNodeV1": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "kind",
      "roleId",
      "executor",
      "capabilityRef",
      "budget",
      "id",
      "title",
      "dependsOn",
      "inputs",
      "outputs"
    ],
    "properties": {
      "kind": {
        "type": "string",
        "const": "agent"
      },
      "roleId": {
        "type": "string"
      },
      "executor": {
        "$ref": "#/components/schemas/OutputGoalPlanProposalV2"
      },
      "capabilityRef": {
        "$ref": "#/components/schemas/OutputTeamCapabilityRefV1"
      },
      "budget": {
        "$ref": "#/components/schemas/OutputGoalBudgetV2"
      },
      "review": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "independent",
          "producerNodeIds"
        ],
        "properties": {
          "independent": {
            "type": "boolean",
            "const": true
          },
          "producerNodeIds": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        }
      },
      "id": {
        "type": "string"
      },
      "title": {
        "type": "string"
      },
      "dependsOn": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "inputs": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputTeamNodeInputV1"
        }
      },
      "outputs": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputTeamNodeOutputSpecV1"
        }
      }
    }
  },
  "OutputTeamHumanDecisionNodeV1": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "kind",
      "prompt",
      "choices",
      "id",
      "title",
      "dependsOn",
      "inputs",
      "outputs"
    ],
    "properties": {
      "kind": {
        "type": "string",
        "const": "human_decision"
      },
      "prompt": {
        "type": "string"
      },
      "choices": {
        "type": "array",
        "items": {
          "anyOf": [
            {
              "type": "string",
              "const": "continue"
            },
            {
              "type": "string",
              "const": "stop"
            }
          ]
        }
      },
      "id": {
        "type": "string"
      },
      "title": {
        "type": "string"
      },
      "dependsOn": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "inputs": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputTeamNodeInputV1"
        }
      },
      "outputs": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputTeamNodeOutputSpecV1"
        }
      }
    }
  },
  "OutputTeamJoinNodeV1": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "kind",
      "mappings",
      "id",
      "title",
      "dependsOn",
      "inputs",
      "outputs"
    ],
    "properties": {
      "kind": {
        "type": "string",
        "const": "join"
      },
      "mappings": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "outputKey",
            "fromNodeId",
            "fromOutputKey"
          ],
          "properties": {
            "outputKey": {
              "type": "string"
            },
            "fromNodeId": {
              "type": "string"
            },
            "fromOutputKey": {
              "type": "string"
            }
          }
        }
      },
      "id": {
        "type": "string"
      },
      "title": {
        "type": "string"
      },
      "dependsOn": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "inputs": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputTeamNodeInputV1"
        }
      },
      "outputs": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputTeamNodeOutputSpecV1"
        }
      }
    }
  },
  "OutputTeamPlanNodeV1": {
    "anyOf": [
      {
        "$ref": "#/components/schemas/OutputTeamAgentNodeV1"
      },
      {
        "$ref": "#/components/schemas/OutputTeamHumanDecisionNodeV1"
      },
      {
        "$ref": "#/components/schemas/OutputTeamJoinNodeV1"
      }
    ]
  },
  "OutputTeamDeliverableBindingV1": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "deliverableKey",
      "nodeId",
      "outputKey"
    ],
    "properties": {
      "deliverableKey": {
        "type": "string"
      },
      "nodeId": {
        "type": "string"
      },
      "outputKey": {
        "type": "string"
      }
    }
  },
  "OutputTeamPlanLimitsV1": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "maxParallelNodes",
      "maxDelegationDepth",
      "maxNodes",
      "maxAttempts",
      "maxReworkRounds"
    ],
    "properties": {
      "maxParallelNodes": {
        "type": "number"
      },
      "maxDelegationDepth": {
        "type": "number"
      },
      "maxNodes": {
        "type": "number"
      },
      "maxAttempts": {
        "type": "number"
      },
      "maxReworkRounds": {
        "type": "number"
      }
    }
  },
  "OutputGoalTeamPlanRevisionV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "goalId",
      "threadId",
      "revision",
      "inputVersion",
      "criteriaVersion",
      "budget",
      "resourceRefs",
      "deliverables",
      "digest",
      "createdAt",
      "kind",
      "template",
      "pluginId",
      "domainInputDigest",
      "threadStreamVersion",
      "nodes",
      "deliverableBindings",
      "limits"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "goalId": {
        "type": "string"
      },
      "threadId": {
        "type": "string"
      },
      "revision": {
        "type": "number"
      },
      "inputVersion": {
        "type": "number"
      },
      "criteriaVersion": {
        "type": "string"
      },
      "budget": {
        "$ref": "#/components/schemas/OutputGoalBudgetV2"
      },
      "resourceRefs": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputGoalResourceRefV2"
        }
      },
      "deliverables": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputGoalDeliverableSpecV2"
        }
      },
      "digest": {
        "type": "string"
      },
      "createdAt": {
        "type": "string"
      },
      "outputFormat": {
        "type": "string",
        "const": "items-v1"
      },
      "kind": {
        "type": "string",
        "const": "team-v1"
      },
      "template": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "id",
          "version",
          "digest"
        ],
        "properties": {
          "id": {
            "$ref": "#/components/schemas/OutputTeamTemplateIdV1"
          },
          "version": {
            "type": "string",
            "const": "1"
          },
          "digest": {
            "type": "string"
          }
        }
      },
      "pluginId": {
        "anyOf": [
          {
            "type": "string",
            "const": "opc"
          },
          {
            "type": "string",
            "const": "coding"
          }
        ]
      },
      "domainInputDigest": {
        "type": "string"
      },
      "threadStreamVersion": {
        "type": "number"
      },
      "nodes": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputTeamPlanNodeV1"
        }
      },
      "deliverableBindings": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputTeamDeliverableBindingV1"
        }
      },
      "limits": {
        "$ref": "#/components/schemas/OutputTeamPlanLimitsV1"
      }
    }
  },
  "OutputGoalSinglePlanRevisionV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "goalId",
      "threadId",
      "revision",
      "inputVersion",
      "criteriaVersion",
      "budget",
      "resourceRefs",
      "deliverables",
      "digest",
      "createdAt",
      "kind",
      "pluginId",
      "domainInputDigest",
      "threadStreamVersion",
      "nodes",
      "deliverableBindings",
      "limits"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "goalId": {
        "type": "string"
      },
      "threadId": {
        "type": "string"
      },
      "revision": {
        "type": "number"
      },
      "inputVersion": {
        "type": "number"
      },
      "criteriaVersion": {
        "type": "string"
      },
      "budget": {
        "$ref": "#/components/schemas/OutputGoalBudgetV2"
      },
      "resourceRefs": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputGoalResourceRefV2"
        }
      },
      "deliverables": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputGoalDeliverableSpecV2"
        }
      },
      "digest": {
        "type": "string"
      },
      "createdAt": {
        "type": "string"
      },
      "kind": {
        "type": "string",
        "const": "single-v2"
      },
      "outputFormat": {
        "type": "string",
        "const": "items-v1"
      },
      "pluginId": {
        "anyOf": [
          {
            "type": "string",
            "const": "opc"
          },
          {
            "type": "string",
            "const": "coding"
          }
        ]
      },
      "domainInputDigest": {
        "type": "string"
      },
      "threadStreamVersion": {
        "type": "number"
      },
      "nodes": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputTeamPlanNodeV1"
        }
      },
      "deliverableBindings": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputTeamDeliverableBindingV1"
        }
      },
      "limits": {
        "$ref": "#/components/schemas/OutputTeamPlanLimitsV1"
      }
    }
  },
  "OutputGoalCoordinatedPlanV2": {
    "anyOf": [
      {
        "$ref": "#/components/schemas/OutputGoalTeamPlanRevisionV2"
      },
      {
        "$ref": "#/components/schemas/OutputGoalSinglePlanRevisionV2"
      }
    ]
  },
  "OutputGoalDeliveryItemDecisionV2": {
    "anyOf": [
      {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "key",
          "digest",
          "decision",
          "reviewedCriterionIds"
        ],
        "properties": {
          "key": {
            "type": "string"
          },
          "digest": {
            "type": "string"
          },
          "decision": {
            "type": "string",
            "const": "accept"
          },
          "reviewedCriterionIds": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        }
      },
      {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "key",
          "digest",
          "decision",
          "failedCriterionIds",
          "instruction"
        ],
        "properties": {
          "key": {
            "type": "string"
          },
          "digest": {
            "type": "string"
          },
          "decision": {
            "type": "string",
            "const": "request_changes"
          },
          "failedCriterionIds": {
            "type": "array",
            "items": {
              "type": "string"
            }
          },
          "instruction": {
            "type": "string"
          }
        }
      },
      {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "key",
          "digest",
          "decision"
        ],
        "properties": {
          "key": {
            "type": "string"
          },
          "digest": {
            "type": "string"
          },
          "decision": {
            "type": "string",
            "const": "defer"
          },
          "reason": {
            "type": "string"
          }
        }
      }
    ]
  },
  "OutputGoalDeliveryDecisionV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "goalId",
      "deliverySetId",
      "criteriaVersion",
      "principalId",
      "decidedAt",
      "goalStreamVersion",
      "items"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "goalId": {
        "type": "string"
      },
      "deliverySetId": {
        "type": "string"
      },
      "criteriaVersion": {
        "type": "string"
      },
      "principalId": {
        "type": "string"
      },
      "decidedAt": {
        "type": "string"
      },
      "goalStreamVersion": {
        "type": "number"
      },
      "items": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputGoalDeliveryItemDecisionV2"
        }
      }
    }
  },
  "OutputGoalOutputReuseV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "nodeId",
      "sourcePlanRevisionId",
      "sourceNodeId",
      "sourceAttemptId",
      "inputDigest",
      "outputs"
    ],
    "properties": {
      "nodeId": {
        "type": "string"
      },
      "sourcePlanRevisionId": {
        "type": "string"
      },
      "sourceNodeId": {
        "type": "string"
      },
      "sourceAttemptId": {
        "type": "string"
      },
      "inputDigest": {
        "type": "string"
      },
      "outputs": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputGoalOutputRefV2"
        }
      }
    }
  },
  "OutputGoalReworkV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "goalId",
      "sourcePlanRevisionId",
      "sourceDeliverySetId",
      "decisionId",
      "planRevisionId",
      "round",
      "createdAt",
      "affectedNodeIds",
      "reuses",
      "retainedOutputs"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "goalId": {
        "type": "string"
      },
      "sourcePlanRevisionId": {
        "type": "string"
      },
      "sourceDeliverySetId": {
        "type": "string"
      },
      "decisionId": {
        "type": "string"
      },
      "planRevisionId": {
        "type": "string"
      },
      "round": {
        "type": "number"
      },
      "createdAt": {
        "type": "string"
      },
      "affectedNodeIds": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "reuses": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputGoalOutputReuseV2"
        }
      },
      "retainedOutputs": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "sourceDeliverySetId",
            "key",
            "outputDigest",
            "output"
          ],
          "properties": {
            "sourceDeliverySetId": {
              "type": "string"
            },
            "key": {
              "type": "string"
            },
            "outputDigest": {
              "type": "string"
            },
            "output": {
              "$ref": "#/components/schemas/OutputGoalOutputRefV2"
            }
          }
        }
      }
    }
  },
  "OutputGoalDeliveryReviewStateV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "decisions",
      "reworks",
      "history"
    ],
    "properties": {
      "decisions": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputGoalDeliveryDecisionV2"
        }
      },
      "reworks": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputGoalReworkV2"
        }
      },
      "history": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "planRevisionId",
            "revision",
            "deliverySet"
          ],
          "properties": {
            "planRevisionId": {
              "type": "string"
            },
            "revision": {
              "type": "number"
            },
            "deliverySet": {
              "anyOf": [
                {
                  "type": "null"
                },
                {
                  "$ref": "#/components/schemas/OutputGoalDeliverySetV2"
                }
              ]
            },
            "usage": {
              "$ref": "#/components/schemas/OutputGoalUsageV2"
            }
          }
        }
      }
    }
  },
  "OutputGoalResponseV2": {
    "anyOf": [
      {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "goal",
          "plan",
          "deliverySet"
        ],
        "properties": {
          "goal": {
            "$ref": "#/components/schemas/OutputGoalV2"
          },
          "plan": {
            "$ref": "#/components/schemas/OutputGoalCoordinatedPlanV2"
          },
          "deliverySet": {
            "anyOf": [
              {
                "type": "null"
              },
              {
                "$ref": "#/components/schemas/OutputGoalDeliverySetV2"
              }
            ]
          },
          "runId": {
            "type": "string"
          },
          "deliveryReview": {
            "$ref": "#/components/schemas/OutputGoalDeliveryReviewStateV2"
          }
        }
      },
      {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "goal",
          "plan",
          "deliverySet"
        ],
        "properties": {
          "goal": {
            "$ref": "#/components/schemas/OutputGoalV2"
          },
          "plan": {
            "anyOf": [
              {
                "type": "null"
              },
              {
                "$ref": "#/components/schemas/OutputGoalPlanRevisionV2"
              }
            ]
          },
          "deliverySet": {
            "anyOf": [
              {
                "type": "null"
              },
              {
                "$ref": "#/components/schemas/OutputGoalDeliverySetV2"
              }
            ]
          },
          "deliveryReview": {
            "$ref": "#/components/schemas/OutputGoalDeliveryReviewStateV2"
          }
        }
      }
    ]
  },
  "OutputGoalReworkPreviewV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "goalId",
      "sourcePlanRevisionId",
      "sourceDeliverySetId",
      "decisionId",
      "expectedGoalStreamVersion",
      "round",
      "affectedNodeIds",
      "reusedNodeIds",
      "retainedDeliverableKeys",
      "remainingBudget",
      "deadlineAt",
      "additionalWork",
      "authorization",
      "plan",
      "digest",
      "createdAt"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "goalId": {
        "type": "string"
      },
      "sourcePlanRevisionId": {
        "type": "string"
      },
      "sourceDeliverySetId": {
        "type": "string"
      },
      "decisionId": {
        "type": "string"
      },
      "expectedGoalStreamVersion": {
        "type": "number"
      },
      "round": {
        "type": "number"
      },
      "affectedNodeIds": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "reusedNodeIds": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "retainedDeliverableKeys": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "remainingBudget": {
        "$ref": "#/components/schemas/OutputGoalBudgetV2"
      },
      "deadlineAt": {
        "type": "string"
      },
      "additionalWork": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "authorization": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "requiresApproval",
          "reasons"
        ],
        "properties": {
          "requiresApproval": {
            "anyOf": [
              {
                "type": "boolean",
                "const": false
              },
              {
                "type": "boolean",
                "const": true
              }
            ]
          },
          "reasons": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        }
      },
      "plan": {
        "$ref": "#/components/schemas/OutputGoalCoordinatedPlanV2"
      },
      "digest": {
        "type": "string"
      },
      "createdAt": {
        "type": "string"
      }
    }
  },
  "OutputOpcBusinessCandidateOriginV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "goalId",
      "planRevisionId",
      "deliverySetId",
      "outputKey",
      "outputDigest"
    ],
    "properties": {
      "goalId": {
        "type": "string"
      },
      "planRevisionId": {
        "type": "string"
      },
      "deliverySetId": {
        "type": "string"
      },
      "outputKey": {
        "type": "string"
      },
      "outputDigest": {
        "type": "string"
      }
    }
  },
  "OutputOpcBusinessCandidateCommandV2": {
    "anyOf": [
      {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "type",
          "quoteId",
          "customerId",
          "serviceId",
          "serviceVersion",
          "quantity",
          "discountMinor",
          "validUntil",
          "dueOn"
        ],
        "properties": {
          "type": {
            "type": "string",
            "const": "quote.create"
          },
          "quoteId": {
            "type": "string"
          },
          "customerId": {
            "type": "string"
          },
          "serviceId": {
            "type": "string"
          },
          "serviceVersion": {
            "type": "number"
          },
          "quantity": {
            "type": "number"
          },
          "discountMinor": {
            "type": "string"
          },
          "validUntil": {
            "type": "string"
          },
          "dueOn": {
            "type": "string"
          },
          "notes": {
            "type": "string"
          }
        }
      },
      {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "type",
          "deliveryId",
          "orderId",
          "title",
          "deliveredOn",
          "artifactRef",
          "progressPercent"
        ],
        "properties": {
          "type": {
            "type": "string",
            "const": "delivery.record"
          },
          "deliveryId": {
            "type": "string"
          },
          "orderId": {
            "type": "string"
          },
          "title": {
            "type": "string"
          },
          "deliveredOn": {
            "type": "string"
          },
          "artifactRef": {
            "type": "string"
          },
          "progressPercent": {
            "type": "number"
          },
          "notes": {
            "type": "string"
          }
        }
      },
      {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "type",
          "reviewId",
          "period",
          "explanation",
          "nextDecisions"
        ],
        "properties": {
          "type": {
            "type": "string",
            "const": "review.record"
          },
          "reviewId": {
            "type": "string"
          },
          "period": {
            "$ref": "#/components/schemas/OutputBusinessPeriodV1"
          },
          "explanation": {
            "type": "string"
          },
          "nextDecisions": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        }
      }
    ]
  },
  "OutputOpcBusinessProposalV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "key",
      "title",
      "rationale",
      "command",
      "evidenceRefs"
    ],
    "properties": {
      "key": {
        "type": "string"
      },
      "title": {
        "type": "string"
      },
      "rationale": {
        "type": "string"
      },
      "command": {
        "$ref": "#/components/schemas/OutputOpcBusinessCandidateCommandV2"
      },
      "evidenceRefs": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputGoalResourceRefV2"
        }
      }
    }
  },
  "OutputOpcBusinessCandidateChangeV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "path",
      "label",
      "before",
      "after"
    ],
    "properties": {
      "path": {
        "type": "string"
      },
      "label": {
        "type": "string"
      },
      "before": {
        "$ref": "#/components/schemas/OutputJsonValue"
      },
      "after": {
        "$ref": "#/components/schemas/OutputJsonValue"
      }
    }
  },
  "OutputOpcBusinessCandidateImpactV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "currency",
      "contractedDeltaMinor",
      "outstandingDeltaMinor",
      "cashReceivedDeltaMinor"
    ],
    "properties": {
      "currency": {
        "type": "string",
        "const": "CNY"
      },
      "quoteTotalMinor": {
        "type": "string"
      },
      "contractedDeltaMinor": {
        "type": "string"
      },
      "outstandingDeltaMinor": {
        "type": "string"
      },
      "cashReceivedDeltaMinor": {
        "type": "string"
      }
    }
  },
  "OutputOpcBusinessCandidateV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schemaVersion",
      "id",
      "tenantId",
      "workspaceId",
      "origin",
      "proposal",
      "sourceRefs",
      "businessStreamVersion",
      "changes",
      "impact",
      "previewDigest",
      "digest",
      "createdAt",
      "createdBy"
    ],
    "properties": {
      "schemaVersion": {
        "type": "string",
        "const": "1"
      },
      "id": {
        "type": "string"
      },
      "tenantId": {
        "type": "string"
      },
      "workspaceId": {
        "type": "string"
      },
      "origin": {
        "$ref": "#/components/schemas/OutputOpcBusinessCandidateOriginV2"
      },
      "proposal": {
        "$ref": "#/components/schemas/OutputOpcBusinessProposalV2"
      },
      "sourceRefs": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputGoalResourceRefV2"
        }
      },
      "businessStreamVersion": {
        "type": "number"
      },
      "changes": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputOpcBusinessCandidateChangeV2"
        }
      },
      "impact": {
        "$ref": "#/components/schemas/OutputOpcBusinessCandidateImpactV2"
      },
      "previewDigest": {
        "type": "string"
      },
      "digest": {
        "type": "string"
      },
      "createdAt": {
        "type": "string"
      },
      "createdBy": {
        "type": "string"
      }
    }
  },
  "OutputOpcBusinessCandidateDecisionV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "candidateId",
      "candidateDigest",
      "decision",
      "decidedBy",
      "decidedAt",
      "businessStreamVersion"
    ],
    "properties": {
      "candidateId": {
        "type": "string"
      },
      "candidateDigest": {
        "type": "string"
      },
      "decision": {
        "anyOf": [
          {
            "type": "string",
            "const": "apply"
          },
          {
            "type": "string",
            "const": "reject"
          }
        ]
      },
      "decidedBy": {
        "type": "string"
      },
      "decidedAt": {
        "type": "string"
      },
      "businessStreamVersion": {
        "type": "number"
      }
    }
  },
  "OutputOpcBusinessCandidateDetailV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "candidate",
      "streamVersion",
      "decision",
      "availability"
    ],
    "properties": {
      "candidate": {
        "$ref": "#/components/schemas/OutputOpcBusinessCandidateV2"
      },
      "streamVersion": {
        "type": "number"
      },
      "decision": {
        "anyOf": [
          {
            "type": "null"
          },
          {
            "$ref": "#/components/schemas/OutputOpcBusinessCandidateDecisionV2"
          }
        ]
      },
      "availability": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "apply",
          "reject",
          "staleReasons"
        ],
        "properties": {
          "apply": {
            "anyOf": [
              {
                "type": "boolean",
                "const": false
              },
              {
                "type": "boolean",
                "const": true
              }
            ]
          },
          "reject": {
            "anyOf": [
              {
                "type": "boolean",
                "const": false
              },
              {
                "type": "boolean",
                "const": true
              }
            ]
          },
          "staleReasons": {
            "type": "array",
            "items": {
              "type": "string"
            }
          }
        }
      }
    }
  },
  "OutputOpcBusinessCandidateListV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "items"
    ],
    "properties": {
      "items": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputOpcBusinessCandidateDetailV2"
        }
      }
    }
  },
  "OutputTeamTemplateSummaryV1": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "version",
      "title",
      "description",
      "pluginId",
      "nodeCount",
      "available"
    ],
    "properties": {
      "id": {
        "$ref": "#/components/schemas/OutputTeamTemplateIdV1"
      },
      "version": {
        "type": "string",
        "const": "1"
      },
      "title": {
        "type": "string"
      },
      "description": {
        "type": "string"
      },
      "pluginId": {
        "anyOf": [
          {
            "type": "string",
            "const": "opc"
          },
          {
            "type": "string",
            "const": "coding"
          }
        ]
      },
      "nodeCount": {
        "type": "number"
      },
      "available": {
        "anyOf": [
          {
            "type": "boolean",
            "const": false
          },
          {
            "type": "boolean",
            "const": true
          }
        ]
      },
      "unavailableReason": {
        "type": "string"
      }
    }
  },
  "OutputGoalTeamNodeProgressV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "nodeId",
      "title",
      "status",
      "attempts",
      "outputRefs"
    ],
    "properties": {
      "nodeId": {
        "type": "string"
      },
      "title": {
        "type": "string"
      },
      "status": {
        "anyOf": [
          {
            "type": "string",
            "const": "queued"
          },
          {
            "type": "string",
            "const": "running"
          },
          {
            "type": "string",
            "const": "waiting_approval"
          },
          {
            "type": "string",
            "const": "paused"
          },
          {
            "type": "string",
            "const": "needs_reconciliation"
          },
          {
            "type": "string",
            "const": "completed"
          },
          {
            "type": "string",
            "const": "failed"
          },
          {
            "type": "string",
            "const": "cancelled"
          },
          {
            "type": "string",
            "const": "pending"
          },
          {
            "type": "string",
            "const": "awaiting_decision"
          }
        ]
      },
      "attempts": {
        "type": "number"
      },
      "blockedReason": {
        "type": "string"
      },
      "executionId": {
        "type": "string"
      },
      "outputRefs": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputGoalResourceRefV2"
        }
      }
    }
  },
  "OutputGoalTeamActionV2": {
    "anyOf": [
      {
        "type": "string",
        "const": "start"
      },
      {
        "type": "string",
        "const": "pause"
      },
      {
        "type": "string",
        "const": "resume"
      },
      {
        "type": "string",
        "const": "cancel"
      },
      {
        "type": "string",
        "const": "decide"
      }
    ]
  },
  "OutputCoordinationBudgetV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "currency",
      "maxTokens",
      "maxCostMinorUnits"
    ],
    "properties": {
      "currency": {
        "type": "string"
      },
      "maxTokens": {
        "type": "number"
      },
      "maxCostMinorUnits": {
        "type": "string"
      }
    }
  },
  "OutputCoordinationAttemptV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "groupId",
      "workspaceId",
      "runId",
      "revisionId",
      "nodeId",
      "ordinal",
      "executionId",
      "generation",
      "threadId",
      "jobId",
      "requestDigest",
      "status",
      "reservation",
      "id",
      "tenantId",
      "streamVersion",
      "createdAt",
      "updatedAt"
    ],
    "properties": {
      "groupId": {
        "type": "string"
      },
      "workspaceId": {
        "type": "string"
      },
      "runId": {
        "type": "string"
      },
      "revisionId": {
        "type": "string"
      },
      "nodeId": {
        "type": "string"
      },
      "ordinal": {
        "type": "number"
      },
      "executionId": {
        "type": "string"
      },
      "generation": {
        "type": "number"
      },
      "threadId": {
        "type": "string"
      },
      "jobId": {
        "type": "string"
      },
      "requestDigest": {
        "type": "string"
      },
      "status": {
        "anyOf": [
          {
            "type": "string",
            "const": "queued"
          },
          {
            "type": "string",
            "const": "paused"
          },
          {
            "type": "string",
            "const": "interrupted"
          },
          {
            "type": "string",
            "const": "needs_reconciliation"
          },
          {
            "type": "string",
            "const": "completed"
          },
          {
            "type": "string",
            "const": "failed"
          },
          {
            "type": "string",
            "const": "cancelled"
          }
        ]
      },
      "reservation": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "budget",
          "status"
        ],
        "properties": {
          "budget": {
            "$ref": "#/components/schemas/OutputCoordinationBudgetV2"
          },
          "status": {
            "anyOf": [
              {
                "type": "string",
                "const": "reserved"
              },
              {
                "type": "string",
                "const": "settled"
              }
            ]
          },
          "usage": {
            "type": "object",
            "additionalProperties": false,
            "required": [
              "currency",
              "tokens",
              "costMinorUnits"
            ],
            "properties": {
              "currency": {
                "type": "string"
              },
              "tokens": {
                "type": "number"
              },
              "costMinorUnits": {
                "type": "string"
              }
            }
          }
        }
      },
      "id": {
        "type": "string"
      },
      "tenantId": {
        "type": "string"
      },
      "streamVersion": {
        "type": "number"
      },
      "createdAt": {
        "type": "string"
      },
      "updatedAt": {
        "type": "string"
      }
    }
  },
  "OutputCoordinationControlV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "workspaceId",
      "runId",
      "revisionId",
      "nodeId",
      "kind",
      "decision",
      "decidedBy",
      "evidenceDigest",
      "id",
      "tenantId",
      "streamVersion",
      "createdAt",
      "updatedAt"
    ],
    "properties": {
      "workspaceId": {
        "type": "string"
      },
      "runId": {
        "type": "string"
      },
      "revisionId": {
        "type": "string"
      },
      "nodeId": {
        "type": "string"
      },
      "kind": {
        "anyOf": [
          {
            "type": "string",
            "const": "human_decision"
          },
          {
            "type": "string",
            "const": "join"
          }
        ]
      },
      "decision": {
        "anyOf": [
          {
            "type": "string",
            "const": "rejected"
          },
          {
            "type": "string",
            "const": "approved"
          }
        ]
      },
      "decidedBy": {
        "type": "string"
      },
      "evidenceDigest": {
        "type": "string"
      },
      "id": {
        "type": "string"
      },
      "tenantId": {
        "type": "string"
      },
      "streamVersion": {
        "type": "number"
      },
      "createdAt": {
        "type": "string"
      },
      "updatedAt": {
        "type": "string"
      }
    }
  },
  "OutputGoalTeamProgressV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "goalId",
      "planRevisionId",
      "nodes",
      "allowedActions",
      "attempts",
      "decisions"
    ],
    "properties": {
      "goalId": {
        "type": "string"
      },
      "planRevisionId": {
        "type": "string"
      },
      "runId": {
        "type": "string"
      },
      "nodes": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputGoalTeamNodeProgressV2"
        }
      },
      "allowedActions": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputGoalTeamActionV2"
        }
      },
      "attempts": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputCoordinationAttemptV2"
        }
      },
      "decisions": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputCoordinationControlV2"
        }
      }
    }
  },
  "OutputBusinessScopeV1": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "tenantId",
      "workspaceId",
      "principalId",
      "customerId"
    ],
    "properties": {
      "tenantId": {
        "type": "string"
      },
      "workspaceId": {
        "type": "string"
      },
      "principalId": {
        "type": "string"
      },
      "customerId": {
        "type": "string"
      }
    }
  },
  "OutputBusinessVersionRefV1": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "version",
      "digest"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "version": {
        "type": "string"
      },
      "digest": {
        "type": "string"
      }
    }
  },
  "OutputIssueQuotePackageInputV1": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schemaVersion",
      "action",
      "actionId",
      "operationKey",
      "scope",
      "quote",
      "businessDecision",
      "template",
      "renderVersion",
      "exportFormat",
      "issueDate"
    ],
    "properties": {
      "schemaVersion": {
        "type": "string",
        "const": "1"
      },
      "action": {
        "type": "string",
        "const": "issueQuotePackage"
      },
      "actionId": {
        "type": "string"
      },
      "operationKey": {
        "type": "string"
      },
      "scope": {
        "$ref": "#/components/schemas/OutputBusinessScopeV1"
      },
      "quote": {
        "$ref": "#/components/schemas/OutputBusinessVersionRefV1"
      },
      "businessDecision": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "id",
          "digest"
        ],
        "properties": {
          "id": {
            "type": "string"
          },
          "digest": {
            "type": "string"
          }
        }
      },
      "template": {
        "$ref": "#/components/schemas/OutputBusinessVersionRefV1"
      },
      "renderVersion": {
        "type": "string"
      },
      "exportFormat": {
        "type": "string",
        "const": "pdf"
      },
      "issueDate": {
        "type": "string"
      }
    }
  },
  "OutputApproval": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "workspaceId",
      "executionId",
      "toolCallId",
      "effectClass",
      "intent",
      "resourceRefs",
      "authorityCommitment",
      "expiresAt",
      "status",
      "id",
      "tenantId",
      "streamVersion",
      "createdAt",
      "updatedAt"
    ],
    "properties": {
      "workspaceId": {
        "type": "string"
      },
      "executionId": {
        "type": "string"
      },
      "toolCallId": {
        "type": "string"
      },
      "effectClass": {
        "$ref": "#/components/schemas/OutputToolEffectClass"
      },
      "intent": {
        "type": "string"
      },
      "resourceRefs": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputResourceRef"
        }
      },
      "authorityCommitment": {
        "type": "string"
      },
      "expiresAt": {
        "type": "string"
      },
      "status": {
        "anyOf": [
          {
            "type": "string",
            "const": "pending"
          },
          {
            "type": "string",
            "const": "approved_once"
          },
          {
            "type": "string",
            "const": "denied"
          },
          {
            "type": "string",
            "const": "expired"
          }
        ]
      },
      "decidedBy": {
        "type": "string"
      },
      "decidedAt": {
        "type": "string"
      },
      "id": {
        "type": "string"
      },
      "tenantId": {
        "type": "string"
      },
      "streamVersion": {
        "type": "number"
      },
      "createdAt": {
        "type": "string"
      },
      "updatedAt": {
        "type": "string"
      }
    }
  },
  "OutputEffectReceiptFileV1": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "name",
      "mediaType",
      "sha256",
      "protectedContentRef"
    ],
    "properties": {
      "name": {
        "type": "string"
      },
      "mediaType": {
        "type": "string",
        "const": "application/pdf"
      },
      "sha256": {
        "type": "string"
      },
      "protectedContentRef": {
        "type": "string"
      }
    }
  },
  "OutputEffectReceiptV1": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schemaVersion",
      "actionId",
      "operationKey",
      "status",
      "files",
      "observedAt"
    ],
    "properties": {
      "schemaVersion": {
        "type": "string",
        "const": "1"
      },
      "actionId": {
        "type": "string"
      },
      "operationKey": {
        "type": "string"
      },
      "status": {
        "anyOf": [
          {
            "type": "string",
            "const": "completed"
          },
          {
            "type": "string",
            "const": "unknown"
          },
          {
            "type": "string",
            "const": "accepted"
          },
          {
            "type": "string",
            "const": "rejected"
          }
        ]
      },
      "packageId": {
        "type": "string"
      },
      "files": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputEffectReceiptFileV1"
        }
      },
      "reasonCode": {
        "type": "string"
      },
      "observedAt": {
        "type": "string"
      }
    }
  },
  "OutputBusinessActionV1": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schemaVersion",
      "id",
      "tenantId",
      "workspaceId",
      "executionId",
      "jobId",
      "operationKey",
      "actionDigest",
      "action",
      "status",
      "streamVersion",
      "createdAt",
      "updatedAt"
    ],
    "properties": {
      "schemaVersion": {
        "type": "string",
        "const": "1"
      },
      "id": {
        "type": "string"
      },
      "tenantId": {
        "type": "string"
      },
      "workspaceId": {
        "type": "string"
      },
      "executionId": {
        "type": "string"
      },
      "jobId": {
        "type": "string"
      },
      "operationKey": {
        "type": "string"
      },
      "actionDigest": {
        "type": "string"
      },
      "action": {
        "$ref": "#/components/schemas/OutputIssueQuotePackageInputV1"
      },
      "status": {
        "anyOf": [
          {
            "type": "string",
            "const": "queued"
          },
          {
            "type": "string",
            "const": "running"
          },
          {
            "type": "string",
            "const": "waiting_approval"
          },
          {
            "type": "string",
            "const": "needs_reconciliation"
          },
          {
            "type": "string",
            "const": "completed"
          },
          {
            "type": "string",
            "const": "rejected"
          },
          {
            "type": "string",
            "const": "terminated"
          }
        ]
      },
      "streamVersion": {
        "type": "number"
      },
      "createdAt": {
        "type": "string"
      },
      "updatedAt": {
        "type": "string"
      },
      "approvalId": {
        "type": "string"
      },
      "approval": {
        "$ref": "#/components/schemas/OutputApproval"
      },
      "receipt": {
        "$ref": "#/components/schemas/OutputEffectReceiptV1"
      }
    }
  },
  "OutputBusinessCandidateV1": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schemaVersion",
      "id",
      "tenantId",
      "workspaceId",
      "scope",
      "inquiryId",
      "inquiryRevision",
      "sourceDigest",
      "executionId",
      "jobId",
      "workflowVersion",
      "status",
      "streamVersion",
      "createdAt",
      "updatedAt"
    ],
    "properties": {
      "schemaVersion": {
        "type": "string",
        "const": "1"
      },
      "id": {
        "type": "string"
      },
      "tenantId": {
        "type": "string"
      },
      "workspaceId": {
        "type": "string"
      },
      "scope": {
        "$ref": "#/components/schemas/OutputBusinessScopeV1"
      },
      "inquiryId": {
        "type": "string"
      },
      "inquiryRevision": {
        "type": "string"
      },
      "sourceDigest": {
        "type": "string"
      },
      "executionId": {
        "type": "string"
      },
      "jobId": {
        "type": "string"
      },
      "workflowVersion": {
        "type": "string",
        "const": "1"
      },
      "status": {
        "anyOf": [
          {
            "type": "string",
            "const": "queued"
          },
          {
            "type": "string",
            "const": "running"
          },
          {
            "type": "string",
            "const": "needs_reconciliation"
          },
          {
            "type": "string",
            "const": "completed"
          },
          {
            "type": "string",
            "const": "failed"
          }
        ]
      },
      "streamVersion": {
        "type": "number"
      },
      "createdAt": {
        "type": "string"
      },
      "updatedAt": {
        "type": "string"
      },
      "candidateDigest": {
        "type": "string"
      },
      "counts": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "requirements",
          "facts",
          "suggestions",
          "unknown",
          "conflicts"
        ],
        "properties": {
          "requirements": {
            "type": "number"
          },
          "facts": {
            "type": "number"
          },
          "suggestions": {
            "type": "number"
          },
          "unknown": {
            "type": "number"
          },
          "conflicts": {
            "type": "number"
          }
        }
      },
      "reasonCode": {
        "type": "string"
      }
    }
  },
  "OutputRfqCitationV1": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "sourceId",
      "pageNumber",
      "start",
      "end",
      "quote"
    ],
    "properties": {
      "sourceId": {
        "type": "string"
      },
      "pageNumber": {
        "type": "number"
      },
      "start": {
        "type": "number"
      },
      "end": {
        "type": "number"
      },
      "quote": {
        "type": "string"
      }
    }
  },
  "OutputRfqCandidateItemV1": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "text",
      "citations"
    ],
    "properties": {
      "text": {
        "type": "string"
      },
      "citations": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputRfqCitationV1"
        }
      }
    }
  },
  "OutputRfqCandidateV1": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schemaVersion",
      "inquiryId",
      "inquiryRevision",
      "sourceDigest",
      "modelProvenance",
      "requirements",
      "facts",
      "suggestions",
      "unknown",
      "conflicts"
    ],
    "properties": {
      "schemaVersion": {
        "type": "string",
        "const": "1"
      },
      "inquiryId": {
        "type": "string"
      },
      "inquiryRevision": {
        "type": "string"
      },
      "sourceDigest": {
        "type": "string"
      },
      "modelProvenance": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "providerId",
          "modelId",
          "mode"
        ],
        "properties": {
          "providerId": {
            "type": "string"
          },
          "modelId": {
            "type": "string"
          },
          "mode": {
            "anyOf": [
              {
                "type": "string",
                "const": "live"
              },
              {
                "type": "string",
                "const": "test_fixture"
              }
            ]
          }
        }
      },
      "requirements": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputRfqCandidateItemV1"
        }
      },
      "facts": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputRfqCandidateItemV1"
        }
      },
      "suggestions": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputRfqCandidateItemV1"
        }
      },
      "unknown": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputRfqCandidateItemV1"
        }
      },
      "conflicts": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputRfqCandidateItemV1"
        }
      }
    }
  },
  "OutputBusinessCandidateContentV1": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "schemaVersion",
      "id",
      "scope",
      "digest",
      "candidate"
    ],
    "properties": {
      "schemaVersion": {
        "type": "string",
        "const": "1"
      },
      "id": {
        "type": "string"
      },
      "scope": {
        "$ref": "#/components/schemas/OutputBusinessScopeV1"
      },
      "digest": {
        "type": "string"
      },
      "candidate": {
        "$ref": "#/components/schemas/OutputRfqCandidateV1"
      }
    }
  },
  "OutputPluginInputFieldV1": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "name",
      "type"
    ],
    "properties": {
      "name": {
        "type": "string"
      },
      "label": {
        "type": "string"
      },
      "type": {
        "anyOf": [
          {
            "type": "string",
            "const": "string"
          },
          {
            "type": "string",
            "const": "number"
          },
          {
            "type": "string",
            "const": "boolean"
          }
        ]
      },
      "required": {
        "anyOf": [
          {
            "type": "boolean",
            "const": false
          },
          {
            "type": "boolean",
            "const": true
          }
        ]
      }
    }
  },
  "OutputPluginCardV1": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "title",
      "body"
    ],
    "properties": {
      "title": {
        "type": "string"
      },
      "body": {
        "type": "string"
      },
      "commandId": {
        "type": "string"
      },
      "fields": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputPluginInputFieldV1"
        }
      }
    }
  },
  "OutputPluginUiV1": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "pages",
      "widgets"
    ],
    "properties": {
      "pages": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "routeId",
            "title",
            "cards"
          ],
          "properties": {
            "routeId": {
              "type": "string"
            },
            "title": {
              "type": "string"
            },
            "cards": {
              "type": "array",
              "items": {
                "$ref": "#/components/schemas/OutputPluginCardV1"
              }
            }
          }
        }
      },
      "widgets": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "widgetId",
            "card"
          ],
          "properties": {
            "widgetId": {
              "type": "string"
            },
            "card": {
              "$ref": "#/components/schemas/OutputPluginCardV1"
            }
          }
        }
      }
    }
  },
  "OutputPluginCliV1": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "commands"
    ],
    "properties": {
      "commands": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "name",
            "commandId",
            "description",
            "fields"
          ],
          "properties": {
            "name": {
              "type": "string"
            },
            "commandId": {
              "type": "string"
            },
            "description": {
              "type": "string"
            },
            "fields": {
              "type": "array",
              "items": {
                "$ref": "#/components/schemas/OutputPluginInputFieldV1"
              }
            }
          }
        }
      }
    }
  },
  "OutputWorkspacePluginSurfaceV1": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "pluginId",
      "version",
      "navigation"
    ],
    "properties": {
      "pluginId": {
        "type": "string"
      },
      "version": {
        "type": "string"
      },
      "navigation": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "id",
            "label",
            "routeId"
          ],
          "properties": {
            "id": {
              "type": "string"
            },
            "label": {
              "type": "string"
            },
            "routeId": {
              "type": "string"
            },
            "order": {
              "type": "number"
            }
          }
        }
      },
      "ui": {
        "$ref": "#/components/schemas/OutputPluginUiV1"
      },
      "cli": {
        "$ref": "#/components/schemas/OutputPluginCliV1"
      }
    }
  },
  "OutputPluginPermissionV1": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "effectClasses",
      "description",
      "required"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "effectClasses": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputToolEffectClass"
        }
      },
      "description": {
        "type": "string"
      },
      "required": {
        "anyOf": [
          {
            "type": "boolean",
            "const": false
          },
          {
            "type": "boolean",
            "const": true
          }
        ]
      }
    }
  },
  "OutputPluginCatalogItemV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "description",
      "version",
      "displayName",
      "license",
      "permissions",
      "packageSha256",
      "release",
      "pluginId",
      "trustBoundary"
    ],
    "properties": {
      "description": {
        "type": "string"
      },
      "version": {
        "type": "string"
      },
      "displayName": {
        "type": "string"
      },
      "license": {
        "type": "string"
      },
      "permissions": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputPluginPermissionV1"
        }
      },
      "packageSha256": {
        "type": "string"
      },
      "release": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "sequence",
          "publishedAt",
          "expiresAt",
          "source"
        ],
        "properties": {
          "sequence": {
            "type": "number"
          },
          "publishedAt": {
            "type": "string"
          },
          "expiresAt": {
            "type": "string"
          },
          "source": {
            "type": "string"
          }
        }
      },
      "pluginId": {
        "type": "string"
      },
      "trustBoundary": {
        "type": "string",
        "const": "process_equivalent"
      }
    }
  },
  "OutputHostHealthV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "core",
      "plugins"
    ],
    "properties": {
      "core": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "status"
        ],
        "properties": {
          "status": {
            "type": "string",
            "const": "healthy"
          }
        }
      },
      "plugins": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "pluginId",
            "status"
          ],
          "properties": {
            "pluginId": {
              "type": "string"
            },
            "status": {
              "anyOf": [
                {
                  "type": "string",
                  "const": "healthy"
                },
                {
                  "type": "string",
                  "const": "degraded"
                }
              ]
            },
            "message": {
              "type": "string"
            }
          }
        }
      }
    }
  },
  "OutputReadinessV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "ready",
      "issues"
    ],
    "properties": {
      "ready": {
        "anyOf": [
          {
            "type": "boolean",
            "const": false
          },
          {
            "type": "boolean",
            "const": true
          }
        ]
      },
      "issues": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "code",
            "message",
            "action"
          ],
          "properties": {
            "code": {
              "type": "string"
            },
            "message": {
              "type": "string"
            },
            "action": {
              "type": "string"
            }
          }
        }
      }
    }
  },
  "OutputWorkspace": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "name",
      "viewMode",
      "activePluginIds",
      "id",
      "tenantId",
      "streamVersion",
      "createdAt",
      "updatedAt"
    ],
    "properties": {
      "name": {
        "type": "string"
      },
      "description": {
        "type": "string"
      },
      "viewMode": {
        "anyOf": [
          {
            "type": "string",
            "const": "business"
          },
          {
            "type": "string",
            "const": "professional"
          }
        ]
      },
      "activePluginIds": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "id": {
        "type": "string"
      },
      "tenantId": {
        "type": "string"
      },
      "streamVersion": {
        "type": "number"
      },
      "createdAt": {
        "type": "string"
      },
      "updatedAt": {
        "type": "string"
      }
    }
  },
  "OutputOrganizationRole": {
    "anyOf": [
      {
        "type": "string",
        "const": "organization_admin"
      },
      {
        "type": "string",
        "const": "governance_admin"
      },
      {
        "type": "string",
        "const": "auditor"
      }
    ]
  },
  "OutputWorkspaceRole": {
    "anyOf": [
      {
        "type": "string",
        "const": "owner"
      },
      {
        "type": "string",
        "const": "operator"
      },
      {
        "type": "string",
        "const": "reviewer"
      },
      {
        "type": "string",
        "const": "viewer"
      }
    ]
  },
  "OutputWorkspaceMembership": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "workspaceId",
      "principalId",
      "organizationRoles",
      "workspaceRole",
      "id",
      "tenantId",
      "streamVersion",
      "createdAt",
      "updatedAt"
    ],
    "properties": {
      "workspaceId": {
        "type": "string"
      },
      "principalId": {
        "type": "string"
      },
      "organizationRoles": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputOrganizationRole"
        }
      },
      "workspaceRole": {
        "$ref": "#/components/schemas/OutputWorkspaceRole"
      },
      "removedAt": {
        "type": "string"
      },
      "id": {
        "type": "string"
      },
      "tenantId": {
        "type": "string"
      },
      "streamVersion": {
        "type": "number"
      },
      "createdAt": {
        "type": "string"
      },
      "updatedAt": {
        "type": "string"
      }
    }
  },
  "OutputAgentCatalogAgentV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "pluginId",
      "id",
      "displayName",
      "description"
    ],
    "properties": {
      "pluginId": {
        "type": "string"
      },
      "id": {
        "type": "string"
      },
      "displayName": {
        "type": "string"
      },
      "description": {
        "type": "string"
      }
    }
  },
  "OutputAgentCatalogSkillV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "pluginId",
      "id",
      "title",
      "expectedOutcome",
      "source",
      "license",
      "version",
      "permissionIds",
      "installation"
    ],
    "properties": {
      "pluginId": {
        "type": "string"
      },
      "id": {
        "type": "string"
      },
      "title": {
        "type": "string"
      },
      "expectedOutcome": {
        "type": "string"
      },
      "exampleInput": {
        "type": "string"
      },
      "source": {
        "type": "string"
      },
      "license": {
        "type": "string"
      },
      "version": {
        "type": "string"
      },
      "permissionIds": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "installation": {
        "type": "string",
        "const": "active"
      }
    }
  },
  "OutputAgentCatalogV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "agents",
      "skills"
    ],
    "properties": {
      "agents": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputAgentCatalogAgentV2"
        }
      },
      "skills": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputAgentCatalogSkillV2"
        }
      }
    }
  },
  "OutputProductNavigationV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "pluginId"
    ],
    "properties": {
      "pluginId": {
        "type": "string"
      },
      "threadId": {
        "type": "string"
      },
      "resourceRef": {
        "$ref": "#/components/schemas/OutputResourceRef"
      }
    }
  },
  "OutputHomeActionV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "title",
      "detail"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "title": {
        "type": "string"
      },
      "detail": {
        "type": "string"
      },
      "pluginId": {
        "type": "string"
      },
      "navigation": {
        "$ref": "#/components/schemas/OutputProductNavigationV2"
      }
    }
  },
  "OutputHomeApprovalV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "title",
      "intent",
      "resourceSummary",
      "risk",
      "expiresAt",
      "streamVersion"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "title": {
        "type": "string"
      },
      "intent": {
        "type": "string"
      },
      "resourceSummary": {
        "type": "string"
      },
      "risk": {
        "type": "string"
      },
      "expiresAt": {
        "type": "string"
      },
      "streamVersion": {
        "type": "number"
      }
    }
  },
  "OutputDeliverableSummaryV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "pluginId",
      "title",
      "outcome",
      "createdAt"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "pluginId": {
        "type": "string"
      },
      "title": {
        "type": "string"
      },
      "outcome": {
        "type": "string"
      },
      "decision": {
        "type": "string"
      },
      "nextAction": {
        "type": "string"
      },
      "createdAt": {
        "type": "string"
      },
      "navigation": {
        "$ref": "#/components/schemas/OutputProductNavigationV2"
      }
    }
  },
  "OutputHomeV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "todayActions",
      "blockers",
      "approvals",
      "recentDeliverables"
    ],
    "properties": {
      "todayActions": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputHomeActionV2"
        }
      },
      "blockers": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputHomeActionV2"
        }
      },
      "approvals": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputHomeApprovalV2"
        }
      },
      "recentDeliverables": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputDeliverableSummaryV2"
        }
      }
    }
  },
  "OutputThread": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "workspaceId",
      "subject",
      "pluginId",
      "id",
      "tenantId",
      "streamVersion",
      "createdAt",
      "updatedAt"
    ],
    "properties": {
      "workspaceId": {
        "type": "string"
      },
      "subject": {
        "type": "string"
      },
      "pluginId": {
        "type": "string"
      },
      "resourceRef": {
        "$ref": "#/components/schemas/OutputResourceRef"
      },
      "sessionLogHead": {
        "type": "string"
      },
      "archivedAt": {
        "type": "string"
      },
      "id": {
        "type": "string"
      },
      "tenantId": {
        "type": "string"
      },
      "streamVersion": {
        "type": "number"
      },
      "createdAt": {
        "type": "string"
      },
      "updatedAt": {
        "type": "string"
      }
    }
  },
  "OutputExecutionStatus": {
    "anyOf": [
      {
        "type": "string",
        "const": "queued"
      },
      {
        "type": "string",
        "const": "running"
      },
      {
        "type": "string",
        "const": "waiting_approval"
      },
      {
        "type": "string",
        "const": "paused"
      },
      {
        "type": "string",
        "const": "interrupted"
      },
      {
        "type": "string",
        "const": "needs_reconciliation"
      },
      {
        "type": "string",
        "const": "completed"
      },
      {
        "type": "string",
        "const": "failed"
      },
      {
        "type": "string",
        "const": "cancelled"
      }
    ]
  },
  "OutputExecution": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "workspaceId",
      "threadId",
      "pluginId",
      "agentDefinitionId",
      "modelBindingId",
      "initiatedBy",
      "executionPrincipalId",
      "generation",
      "status",
      "authorityId",
      "id",
      "tenantId",
      "streamVersion",
      "createdAt",
      "updatedAt"
    ],
    "properties": {
      "pluginPackageSha256": {
        "type": "string"
      },
      "workspaceId": {
        "type": "string"
      },
      "threadId": {
        "type": "string"
      },
      "pluginId": {
        "type": "string"
      },
      "agentDefinitionId": {
        "type": "string"
      },
      "modelBindingId": {
        "type": "string"
      },
      "initiatedBy": {
        "type": "string"
      },
      "executionPrincipalId": {
        "type": "string"
      },
      "generation": {
        "type": "number"
      },
      "status": {
        "$ref": "#/components/schemas/OutputExecutionStatus"
      },
      "authorityId": {
        "type": "string"
      },
      "parentExecutionId": {
        "type": "string"
      },
      "startedAt": {
        "type": "string"
      },
      "finishedAt": {
        "type": "string"
      },
      "failureCode": {
        "type": "string"
      },
      "runnerId": {
        "anyOf": [
          {
            "type": "string",
            "const": "builtin"
          },
          {
            "type": "string",
            "const": "claude-cli"
          },
          {
            "type": "string",
            "const": "codex-cli"
          }
        ]
      },
      "id": {
        "type": "string"
      },
      "tenantId": {
        "type": "string"
      },
      "streamVersion": {
        "type": "number"
      },
      "createdAt": {
        "type": "string"
      },
      "updatedAt": {
        "type": "string"
      }
    }
  },
  "OutputThreadTurnSessionEntry": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "executionId",
      "role",
      "content",
      "turn",
      "sequence",
      "occurredAt"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "executionId": {
        "type": "string"
      },
      "role": {
        "anyOf": [
          {
            "type": "string",
            "const": "user"
          },
          {
            "type": "string",
            "const": "assistant"
          },
          {
            "type": "string",
            "const": "tool"
          }
        ]
      },
      "content": {
        "type": "string"
      },
      "turn": {
        "type": "number"
      },
      "sequence": {
        "type": "number"
      },
      "occurredAt": {
        "type": "string"
      }
    }
  },
  "OutputExecutionMeteringView": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "status",
      "currency",
      "knownTokens",
      "estimatedCostNanoMinorUnits",
      "maxTokens",
      "maxCostMinorUnits",
      "pendingRequests",
      "inputCountEstimated",
      "billingGuarantee"
    ],
    "properties": {
      "status": {
        "anyOf": [
          {
            "type": "string",
            "const": "not_started"
          },
          {
            "type": "string",
            "const": "estimated"
          },
          {
            "type": "string",
            "const": "pending"
          },
          {
            "type": "string",
            "const": "overrun"
          },
          {
            "type": "string",
            "const": "external_runner"
          }
        ]
      },
      "currency": {
        "type": "string"
      },
      "knownTokens": {
        "type": "number"
      },
      "estimatedCostNanoMinorUnits": {
        "type": "string"
      },
      "maxTokens": {
        "type": "number"
      },
      "maxCostMinorUnits": {
        "type": "string"
      },
      "pendingRequests": {
        "type": "number"
      },
      "inputCountEstimated": {
        "anyOf": [
          {
            "type": "boolean",
            "const": false
          },
          {
            "type": "boolean",
            "const": true
          }
        ]
      },
      "billingGuarantee": {
        "type": "boolean",
        "const": false
      }
    }
  },
  "OutputThreadTurnView": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "execution",
      "entries"
    ],
    "properties": {
      "execution": {
        "$ref": "#/components/schemas/OutputExecution"
      },
      "entries": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputThreadTurnSessionEntry"
        }
      },
      "metering": {
        "$ref": "#/components/schemas/OutputExecutionMeteringView"
      },
      "pauseReason": {
        "type": "string"
      }
    }
  },
  "OutputThreadTurnsView": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "threadId",
      "turns"
    ],
    "properties": {
      "threadId": {
        "type": "string"
      },
      "turns": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputThreadTurnView"
        }
      }
    }
  },
  "OutputInboxItemV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "tenantId",
      "workspaceId",
      "kind",
      "title",
      "summary",
      "createdAt",
      "status"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "tenantId": {
        "type": "string"
      },
      "workspaceId": {
        "type": "string"
      },
      "executionId": {
        "type": "string"
      },
      "navigation": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "pluginId",
          "threadId"
        ],
        "properties": {
          "pluginId": {
            "type": "string"
          },
          "threadId": {
            "type": "string"
          },
          "resourceRef": {
            "$ref": "#/components/schemas/OutputResourceRef"
          }
        }
      },
      "revocationId": {
        "type": "string"
      },
      "streamVersion": {
        "type": "number"
      },
      "kind": {
        "anyOf": [
          {
            "type": "string",
            "const": "approval"
          },
          {
            "type": "string",
            "const": "agent_question"
          },
          {
            "type": "string",
            "const": "credential"
          },
          {
            "type": "string",
            "const": "failure"
          },
          {
            "type": "string",
            "const": "reconciliation"
          }
        ]
      },
      "title": {
        "type": "string"
      },
      "summary": {
        "type": "string"
      },
      "risk": {
        "type": "string"
      },
      "resourceSummary": {
        "type": "string"
      },
      "expiresAt": {
        "type": "string"
      },
      "createdAt": {
        "type": "string"
      },
      "status": {
        "anyOf": [
          {
            "type": "string",
            "const": "open"
          },
          {
            "type": "string",
            "const": "resolved"
          }
        ]
      }
    }
  },
  "OutputActivityV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "title",
      "status",
      "cost",
      "occurredAt"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "title": {
        "type": "string"
      },
      "status": {
        "type": "string"
      },
      "cost": {
        "type": "string"
      },
      "occurredAt": {
        "type": "string"
      }
    }
  },
  "OutputAsset": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "workspaceId",
      "digest",
      "mediaType",
      "byteLength",
      "fileName",
      "protected",
      "id",
      "tenantId",
      "streamVersion",
      "createdAt",
      "updatedAt"
    ],
    "properties": {
      "workspaceId": {
        "type": "string"
      },
      "digest": {
        "type": "string"
      },
      "mediaType": {
        "type": "string"
      },
      "byteLength": {
        "type": "number"
      },
      "fileName": {
        "type": "string"
      },
      "protected": {
        "anyOf": [
          {
            "type": "boolean",
            "const": false
          },
          {
            "type": "boolean",
            "const": true
          }
        ]
      },
      "protectedPayloadRef": {
        "type": "string"
      },
      "id": {
        "type": "string"
      },
      "tenantId": {
        "type": "string"
      },
      "streamVersion": {
        "type": "number"
      },
      "createdAt": {
        "type": "string"
      },
      "updatedAt": {
        "type": "string"
      }
    }
  },
  "OutputDocumentLocatorV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [],
    "properties": {
      "page": {
        "type": "number"
      },
      "paragraph": {
        "type": "number"
      },
      "sheet": {
        "type": "string"
      },
      "cell": {
        "type": "string"
      },
      "row": {
        "type": "number"
      },
      "column": {
        "type": "number"
      },
      "part": {
        "type": "string"
      }
    }
  },
  "OutputAssetExtractionV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "assetRef",
      "fileName",
      "mediaType",
      "status",
      "blocks",
      "issues",
      "extractorVersion",
      "textDigest"
    ],
    "properties": {
      "assetRef": {
        "$ref": "#/components/schemas/OutputGoalResourceRefV2"
      },
      "fileName": {
        "type": "string"
      },
      "mediaType": {
        "type": "string"
      },
      "status": {
        "anyOf": [
          {
            "type": "string",
            "const": "complete"
          },
          {
            "type": "string",
            "const": "partial"
          },
          {
            "type": "string",
            "const": "unreadable"
          }
        ]
      },
      "blocks": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "id",
            "text",
            "locator"
          ],
          "properties": {
            "id": {
              "type": "string"
            },
            "text": {
              "type": "string"
            },
            "locator": {
              "$ref": "#/components/schemas/OutputDocumentLocatorV2"
            }
          }
        }
      },
      "issues": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "code",
            "message"
          ],
          "properties": {
            "code": {
              "type": "string"
            },
            "message": {
              "type": "string"
            },
            "locator": {
              "$ref": "#/components/schemas/OutputDocumentLocatorV2"
            }
          }
        }
      },
      "extractorVersion": {
        "type": "string",
        "const": "1"
      },
      "textDigest": {
        "type": "string"
      }
    }
  },
  "OutputAssetTombstone": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "workspaceId",
      "protected",
      "objectDigest",
      "reasonDigest",
      "deletedAt",
      "id",
      "tenantId",
      "streamVersion",
      "createdAt",
      "updatedAt"
    ],
    "properties": {
      "workspaceId": {
        "type": "string"
      },
      "protected": {
        "anyOf": [
          {
            "type": "boolean",
            "const": false
          },
          {
            "type": "boolean",
            "const": true
          }
        ]
      },
      "objectDigest": {
        "type": "string"
      },
      "reasonDigest": {
        "type": "string"
      },
      "deletedAt": {
        "type": "string"
      },
      "id": {
        "type": "string"
      },
      "tenantId": {
        "type": "string"
      },
      "streamVersion": {
        "type": "number"
      },
      "createdAt": {
        "type": "string"
      },
      "updatedAt": {
        "type": "string"
      }
    }
  },
  "OutputMemorySummaryV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "namespace",
      "resourceId",
      "summary",
      "source",
      "confidence",
      "status",
      "streamVersion"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "namespace": {
        "type": "string"
      },
      "resourceId": {
        "type": "string"
      },
      "summary": {
        "type": "string"
      },
      "source": {
        "type": "string"
      },
      "confidence": {
        "type": "number"
      },
      "status": {
        "anyOf": [
          {
            "type": "string",
            "const": "proposed"
          },
          {
            "type": "string",
            "const": "accepted"
          },
          {
            "type": "string",
            "const": "rejected"
          },
          {
            "type": "string",
            "const": "deletion_pending"
          },
          {
            "type": "string",
            "const": "deleted"
          },
          {
            "type": "string",
            "const": "invalidated"
          }
        ]
      },
      "streamVersion": {
        "type": "number"
      }
    }
  },
  "OutputMemoryViewV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "workspaceId",
      "id",
      "tenantId",
      "streamVersion",
      "namespace",
      "resourceId",
      "status",
      "createdAt",
      "updatedAt",
      "scopeType",
      "sourceEventId",
      "confidence",
      "shareGrantIds",
      "value"
    ],
    "properties": {
      "workspaceId": {
        "type": "string"
      },
      "id": {
        "type": "string"
      },
      "tenantId": {
        "type": "string"
      },
      "streamVersion": {
        "type": "number"
      },
      "namespace": {
        "type": "string"
      },
      "resourceId": {
        "type": "string"
      },
      "expiresAt": {
        "type": "string"
      },
      "status": {
        "anyOf": [
          {
            "type": "string",
            "const": "proposed"
          },
          {
            "type": "string",
            "const": "accepted"
          },
          {
            "type": "string",
            "const": "rejected"
          },
          {
            "type": "string",
            "const": "deletion_pending"
          },
          {
            "type": "string",
            "const": "deleted"
          },
          {
            "type": "string",
            "const": "invalidated"
          }
        ]
      },
      "createdAt": {
        "type": "string"
      },
      "updatedAt": {
        "type": "string"
      },
      "scopeType": {
        "anyOf": [
          {
            "type": "string",
            "const": "workspace"
          },
          {
            "type": "string",
            "const": "thread"
          },
          {
            "type": "string",
            "const": "resource"
          },
          {
            "type": "string",
            "const": "principal"
          }
        ]
      },
      "sourceEventId": {
        "type": "string"
      },
      "confidence": {
        "type": "number"
      },
      "confirmedAt": {
        "type": "string"
      },
      "shareGrantIds": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "derivedFromMemoryId": {
        "type": "string"
      },
      "derivedViaShareGrantId": {
        "type": "string"
      },
      "value": {
        "$ref": "#/components/schemas/OutputJsonObject"
      }
    }
  },
  "OutputMemoryTombstone": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "workspaceId",
      "status",
      "objectDigest",
      "reason",
      "deletedAt",
      "id",
      "tenantId",
      "streamVersion",
      "createdAt",
      "updatedAt"
    ],
    "properties": {
      "workspaceId": {
        "type": "string"
      },
      "status": {
        "type": "string",
        "const": "deleted"
      },
      "objectDigest": {
        "type": "string"
      },
      "reason": {
        "type": "string"
      },
      "deletedAt": {
        "type": "string"
      },
      "id": {
        "type": "string"
      },
      "tenantId": {
        "type": "string"
      },
      "streamVersion": {
        "type": "number"
      },
      "createdAt": {
        "type": "string"
      },
      "updatedAt": {
        "type": "string"
      }
    }
  },
  "OutputShareGrant": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "workspaceId",
      "memoryId",
      "fromNamespace",
      "toNamespace",
      "grantedBy",
      "grantedAt",
      "id",
      "tenantId",
      "streamVersion",
      "createdAt",
      "updatedAt"
    ],
    "properties": {
      "workspaceId": {
        "type": "string"
      },
      "memoryId": {
        "type": "string"
      },
      "fromNamespace": {
        "type": "string"
      },
      "toNamespace": {
        "type": "string"
      },
      "grantedBy": {
        "type": "string"
      },
      "grantedAt": {
        "type": "string"
      },
      "revokedAt": {
        "type": "string"
      },
      "id": {
        "type": "string"
      },
      "tenantId": {
        "type": "string"
      },
      "streamVersion": {
        "type": "number"
      },
      "createdAt": {
        "type": "string"
      },
      "updatedAt": {
        "type": "string"
      }
    }
  },
  "OutputModelPresetV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "displayName",
      "secretLabel",
      "suggestedModels"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "displayName": {
        "type": "string"
      },
      "secretLabel": {
        "type": "string"
      },
      "suggestedModels": {
        "type": "array",
        "items": {
          "type": "string"
        }
      }
    }
  },
  "OutputModelConnectionV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "modelOptions",
      "id",
      "tenantId",
      "presetId",
      "displayName",
      "defaultModel",
      "discoveredModels",
      "status",
      "streamVersion"
    ],
    "properties": {
      "billingCurrency": {
        "type": "string"
      },
      "modelOptions": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "modelName",
            "selectable"
          ],
          "properties": {
            "modelName": {
              "type": "string"
            },
            "selectable": {
              "anyOf": [
                {
                  "type": "boolean",
                  "const": false
                },
                {
                  "type": "boolean",
                  "const": true
                }
              ]
            },
            "reason": {
              "type": "string"
            }
          }
        }
      },
      "defaultForNewExecutions": {
        "anyOf": [
          {
            "type": "boolean",
            "const": false
          },
          {
            "type": "boolean",
            "const": true
          }
        ]
      },
      "id": {
        "type": "string"
      },
      "tenantId": {
        "type": "string"
      },
      "presetId": {
        "type": "string"
      },
      "displayName": {
        "type": "string"
      },
      "defaultModel": {
        "type": "string"
      },
      "discoveredModels": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "status": {
        "anyOf": [
          {
            "type": "string",
            "const": "pending"
          },
          {
            "type": "string",
            "const": "ready"
          },
          {
            "type": "string",
            "const": "invalid"
          }
        ]
      },
      "streamVersion": {
        "type": "number"
      }
    }
  },
  "OutputAgentReadinessCheckV1": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "status",
      "message"
    ],
    "properties": {
      "id": {
        "anyOf": [
          {
            "type": "string",
            "const": "model"
          },
          {
            "type": "string",
            "const": "task_plugin"
          },
          {
            "type": "string",
            "const": "runner_plugin"
          },
          {
            "type": "string",
            "const": "permission"
          },
          {
            "type": "string",
            "const": "confirmation"
          },
          {
            "type": "string",
            "const": "binary_identity"
          },
          {
            "type": "string",
            "const": "worker"
          },
          {
            "type": "string",
            "const": "sandbox"
          },
          {
            "type": "string",
            "const": "authentication"
          },
          {
            "type": "string",
            "const": "approval"
          },
          {
            "type": "string",
            "const": "adapter"
          }
        ]
      },
      "status": {
        "anyOf": [
          {
            "type": "string",
            "const": "unknown"
          },
          {
            "type": "string",
            "const": "passed"
          },
          {
            "type": "string",
            "const": "blocked"
          },
          {
            "type": "string",
            "const": "required"
          }
        ]
      },
      "message": {
        "type": "string"
      },
      "action": {
        "type": "string"
      }
    }
  },
  "OutputExternalCodingRunnerId": {
    "anyOf": [
      {
        "type": "string",
        "const": "claude-cli"
      },
      {
        "type": "string",
        "const": "codex-cli"
      }
    ]
  },
  "OutputRunnerBinaryIdentityV1": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "version",
      "requestedPath",
      "realPath",
      "sha256",
      "device",
      "inode",
      "byteLength",
      "modifiedAtMs"
    ],
    "properties": {
      "version": {
        "type": "string"
      },
      "requestedPath": {
        "type": "string"
      },
      "realPath": {
        "type": "string"
      },
      "sha256": {
        "type": "string"
      },
      "device": {
        "type": "string"
      },
      "inode": {
        "type": "string"
      },
      "byteLength": {
        "type": "number"
      },
      "modifiedAtMs": {
        "type": "number"
      }
    }
  },
  "OutputCodingRunnerConfigurationV1": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "workspaceId",
      "runnerId",
      "status",
      "identity",
      "identityDigest",
      "confirmedBy",
      "confirmedAt",
      "id",
      "tenantId",
      "streamVersion",
      "createdAt",
      "updatedAt"
    ],
    "properties": {
      "workspaceId": {
        "type": "string"
      },
      "runnerId": {
        "$ref": "#/components/schemas/OutputExternalCodingRunnerId"
      },
      "status": {
        "type": "string",
        "const": "confirmed"
      },
      "identity": {
        "$ref": "#/components/schemas/OutputRunnerBinaryIdentityV1"
      },
      "identityDigest": {
        "type": "string"
      },
      "confirmedBy": {
        "type": "string"
      },
      "confirmedAt": {
        "type": "string"
      },
      "id": {
        "type": "string"
      },
      "tenantId": {
        "type": "string"
      },
      "streamVersion": {
        "type": "number"
      },
      "createdAt": {
        "type": "string"
      },
      "updatedAt": {
        "type": "string"
      }
    }
  },
  "OutputAgentReadinessV1": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "agentId",
      "displayName",
      "scope",
      "support",
      "status",
      "checks"
    ],
    "properties": {
      "agentId": {
        "anyOf": [
          {
            "type": "string",
            "const": "builtin"
          },
          {
            "type": "string",
            "const": "claude-cli"
          },
          {
            "type": "string",
            "const": "codex-cli"
          },
          {
            "type": "string",
            "const": "workbuddy"
          }
        ]
      },
      "displayName": {
        "type": "string"
      },
      "scope": {
        "type": "string",
        "const": "workspace"
      },
      "support": {
        "anyOf": [
          {
            "type": "string",
            "const": "supported"
          },
          {
            "type": "string",
            "const": "not_supported"
          }
        ]
      },
      "status": {
        "anyOf": [
          {
            "type": "string",
            "const": "blocked"
          },
          {
            "type": "string",
            "const": "unverified"
          }
        ]
      },
      "checks": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputAgentReadinessCheckV1"
        }
      },
      "configuration": {
        "$ref": "#/components/schemas/OutputCodingRunnerConfigurationV1"
      }
    }
  },
  "OutputAgentReadinessReportV1": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "workspaceId",
      "checkedAt",
      "agents"
    ],
    "properties": {
      "workspaceId": {
        "type": "string"
      },
      "checkedAt": {
        "type": "string"
      },
      "agents": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputAgentReadinessV1"
        }
      }
    }
  },
  "OutputPluginInstallation": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "pluginId",
      "version",
      "packageSha256",
      "releaseSequence",
      "status",
      "projectionNamespace",
      "developmentMode",
      "id",
      "tenantId",
      "streamVersion",
      "createdAt",
      "updatedAt"
    ],
    "properties": {
      "pluginId": {
        "type": "string"
      },
      "version": {
        "type": "string"
      },
      "packageSha256": {
        "type": "string"
      },
      "releaseSequence": {
        "type": "number"
      },
      "status": {
        "anyOf": [
          {
            "type": "string",
            "const": "failed"
          },
          {
            "type": "string",
            "const": "installed"
          },
          {
            "type": "string",
            "const": "active"
          },
          {
            "type": "string",
            "const": "draining"
          },
          {
            "type": "string",
            "const": "disabled"
          },
          {
            "type": "string",
            "const": "revoked"
          }
        ]
      },
      "projectionNamespace": {
        "type": "string"
      },
      "developmentMode": {
        "anyOf": [
          {
            "type": "boolean",
            "const": false
          },
          {
            "type": "boolean",
            "const": true
          }
        ]
      },
      "id": {
        "type": "string"
      },
      "tenantId": {
        "type": "string"
      },
      "streamVersion": {
        "type": "number"
      },
      "createdAt": {
        "type": "string"
      },
      "updatedAt": {
        "type": "string"
      }
    }
  },
  "OutputOfficialPluginV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "pluginId",
      "version",
      "activeByDefault",
      "trustBoundary"
    ],
    "properties": {
      "pluginId": {
        "type": "string"
      },
      "version": {
        "type": "string"
      },
      "activeByDefault": {
        "type": "boolean",
        "const": false
      },
      "trustBoundary": {
        "type": "string",
        "const": "process_equivalent"
      }
    }
  },
  "OutputPluginPurgeResult": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "pluginId",
      "purged",
      "streamVersion",
      "purgedAt"
    ],
    "properties": {
      "pluginId": {
        "type": "string"
      },
      "purged": {
        "type": "boolean",
        "const": true
      },
      "streamVersion": {
        "type": "number"
      },
      "purgedAt": {
        "type": "string"
      }
    }
  },
  "OutputOpportunityState": {
    "anyOf": [
      {
        "type": "string",
        "const": "paused"
      },
      {
        "type": "string",
        "const": "captured"
      },
      {
        "type": "string",
        "const": "framed"
      },
      {
        "type": "string",
        "const": "researching"
      },
      {
        "type": "string",
        "const": "interviewing"
      },
      {
        "type": "string",
        "const": "evaluating"
      },
      {
        "type": "string",
        "const": "offer_ready"
      },
      {
        "type": "string",
        "const": "decided"
      },
      {
        "type": "string",
        "const": "abandoned"
      }
    ]
  },
  "OutputEvidenceLevel": {
    "anyOf": [
      {
        "type": "string",
        "const": "none"
      },
      {
        "type": "string",
        "const": "interest"
      },
      {
        "type": "string",
        "const": "commitment"
      },
      {
        "type": "string",
        "const": "paid"
      }
    ]
  },
  "OutputOpportunityEvidenceV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "stance",
      "summary",
      "source",
      "capturedAt"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "stance": {
        "anyOf": [
          {
            "type": "string",
            "const": "neutral"
          },
          {
            "type": "string",
            "const": "supporting"
          },
          {
            "type": "string",
            "const": "opposing"
          }
        ]
      },
      "summary": {
        "type": "string"
      },
      "source": {
        "type": "string"
      },
      "capturedAt": {
        "type": "string"
      },
      "humanConfirmed": {
        "anyOf": [
          {
            "type": "boolean",
            "const": false
          },
          {
            "type": "boolean",
            "const": true
          }
        ]
      }
    }
  },
  "OutputOpportunitySummaryV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "title",
      "targetCustomer",
      "problem",
      "falsifiableHypothesis",
      "status",
      "evidenceLevel",
      "evidence",
      "gaps",
      "nextAction",
      "streamVersion"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "title": {
        "type": "string"
      },
      "targetCustomer": {
        "type": "string"
      },
      "problem": {
        "type": "string"
      },
      "falsifiableHypothesis": {
        "type": "string"
      },
      "status": {
        "$ref": "#/components/schemas/OutputOpportunityState"
      },
      "evidenceLevel": {
        "$ref": "#/components/schemas/OutputEvidenceLevel"
      },
      "evidence": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputOpportunityEvidenceV2"
        }
      },
      "gaps": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "nextAction": {
        "type": "string"
      },
      "streamVersion": {
        "type": "number"
      }
    }
  },
  "OutputHypothesis": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "opportunityId",
      "targetCustomer",
      "problem",
      "statement",
      "falsifiable",
      "createdAt",
      "createdBy"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "opportunityId": {
        "type": "string"
      },
      "targetCustomer": {
        "type": "string"
      },
      "problem": {
        "type": "string"
      },
      "statement": {
        "type": "string"
      },
      "falsifiable": {
        "type": "boolean",
        "const": true
      },
      "createdAt": {
        "type": "string"
      },
      "createdBy": {
        "type": "string"
      }
    }
  },
  "OutputSignalSourceKind": {
    "anyOf": [
      {
        "type": "string",
        "const": "public_web"
      },
      {
        "type": "string",
        "const": "pasted"
      },
      {
        "type": "string",
        "const": "file"
      },
      {
        "type": "string",
        "const": "manual"
      }
    ]
  },
  "OutputSignalRelationship": {
    "anyOf": [
      {
        "type": "string",
        "const": "support"
      },
      {
        "type": "string",
        "const": "oppose"
      },
      {
        "type": "string",
        "const": "neutral"
      }
    ]
  },
  "OutputSignalEvidenceKind": {
    "anyOf": [
      {
        "type": "string",
        "const": "interest"
      },
      {
        "type": "string",
        "const": "context"
      }
    ]
  },
  "OutputSignal": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "opportunityId",
      "sourceKind",
      "observedAt",
      "summary",
      "relationship",
      "evidenceKind",
      "recordedAt",
      "recordedBy"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "opportunityId": {
        "type": "string"
      },
      "sourceKind": {
        "$ref": "#/components/schemas/OutputSignalSourceKind"
      },
      "sourceUrl": {
        "type": "string"
      },
      "sourceAssetId": {
        "type": "string"
      },
      "observedAt": {
        "type": "string"
      },
      "excerpt": {
        "type": "string"
      },
      "summary": {
        "type": "string"
      },
      "relationship": {
        "$ref": "#/components/schemas/OutputSignalRelationship"
      },
      "evidenceKind": {
        "$ref": "#/components/schemas/OutputSignalEvidenceKind"
      },
      "recordedAt": {
        "type": "string"
      },
      "recordedBy": {
        "type": "string"
      }
    }
  },
  "OutputActorKind": {
    "anyOf": [
      {
        "type": "string",
        "const": "human"
      },
      {
        "type": "string",
        "const": "agent"
      }
    ]
  },
  "OutputInterviewAnnotation": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "text",
      "createdAt",
      "createdBy",
      "actorKind"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "text": {
        "type": "string"
      },
      "createdAt": {
        "type": "string"
      },
      "createdBy": {
        "type": "string"
      },
      "actorKind": {
        "$ref": "#/components/schemas/OutputActorKind"
      }
    }
  },
  "OutputInterview": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "opportunityId",
      "participantRef",
      "occurredAt",
      "rawRecordAssetId",
      "recordedAt",
      "recordedBy",
      "annotations"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "opportunityId": {
        "type": "string"
      },
      "participantRef": {
        "type": "string"
      },
      "occurredAt": {
        "type": "string"
      },
      "rawRecordAssetId": {
        "type": "string"
      },
      "recordedAt": {
        "type": "string"
      },
      "recordedBy": {
        "type": "string"
      },
      "annotations": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputInterviewAnnotation"
        }
      }
    }
  },
  "OutputExperiment": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "opportunityId",
      "question",
      "method",
      "successCriterion",
      "status",
      "createdAt",
      "createdBy"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "opportunityId": {
        "type": "string"
      },
      "question": {
        "type": "string"
      },
      "method": {
        "type": "string"
      },
      "successCriterion": {
        "type": "string"
      },
      "outcome": {
        "type": "string"
      },
      "status": {
        "anyOf": [
          {
            "type": "string",
            "const": "completed"
          },
          {
            "type": "string",
            "const": "planned"
          }
        ]
      },
      "createdAt": {
        "type": "string"
      },
      "createdBy": {
        "type": "string"
      }
    }
  },
  "OutputCommitmentEvidenceLevel": {
    "anyOf": [
      {
        "type": "string",
        "const": "commitment"
      },
      {
        "type": "string",
        "const": "paid"
      }
    ]
  },
  "OutputCommitmentEvidence": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "opportunityId",
      "level",
      "description",
      "sourceRef",
      "status",
      "proposedAt",
      "proposedBy"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "opportunityId": {
        "type": "string"
      },
      "level": {
        "$ref": "#/components/schemas/OutputCommitmentEvidenceLevel"
      },
      "description": {
        "type": "string"
      },
      "sourceRef": {
        "type": "string"
      },
      "status": {
        "anyOf": [
          {
            "type": "string",
            "const": "confirmed"
          },
          {
            "type": "string",
            "const": "proposed"
          }
        ]
      },
      "proposedAt": {
        "type": "string"
      },
      "proposedBy": {
        "type": "string"
      },
      "confirmedAt": {
        "type": "string"
      },
      "confirmedBy": {
        "type": "string"
      }
    }
  },
  "OutputPriceAssumption": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "amountMinor",
      "currency",
      "assumption"
    ],
    "properties": {
      "amountMinor": {
        "type": "string"
      },
      "currency": {
        "type": "string"
      },
      "assumption": {
        "type": "string"
      }
    }
  },
  "OutputMinimumPaidOffer": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "opportunityId",
      "preparedAt",
      "preparedBy",
      "targetCustomer",
      "promisedOutcome",
      "inScope",
      "outOfScope",
      "price",
      "deliveryFormat",
      "duration",
      "acceptanceMethod",
      "nextCustomerAction",
      "risks"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "opportunityId": {
        "type": "string"
      },
      "preparedAt": {
        "type": "string"
      },
      "preparedBy": {
        "type": "string"
      },
      "targetCustomer": {
        "type": "string"
      },
      "promisedOutcome": {
        "type": "string"
      },
      "inScope": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "outOfScope": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "price": {
        "$ref": "#/components/schemas/OutputPriceAssumption"
      },
      "deliveryFormat": {
        "type": "string"
      },
      "duration": {
        "type": "string"
      },
      "acceptanceMethod": {
        "type": "string"
      },
      "nextCustomerAction": {
        "type": "string"
      },
      "risks": {
        "type": "array",
        "items": {
          "type": "string"
        }
      }
    }
  },
  "OutputDecisionChoice": {
    "anyOf": [
      {
        "type": "string",
        "const": "stop"
      },
      {
        "type": "string",
        "const": "pursue"
      },
      {
        "type": "string",
        "const": "revise"
      }
    ]
  },
  "OutputDecision": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "opportunityId",
      "choice",
      "rationale",
      "decidedAt",
      "decidedBy"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "opportunityId": {
        "type": "string"
      },
      "choice": {
        "$ref": "#/components/schemas/OutputDecisionChoice"
      },
      "rationale": {
        "type": "string"
      },
      "decidedAt": {
        "type": "string"
      },
      "decidedBy": {
        "type": "string"
      }
    }
  },
  "OutputOpportunityAggregate": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "hypotheses",
      "signals",
      "interviews",
      "experiments",
      "commitmentEvidence",
      "id",
      "workspaceId",
      "title",
      "rawCapture",
      "state",
      "evidenceLevel",
      "streamVersion",
      "createdAt",
      "updatedAt"
    ],
    "properties": {
      "hypotheses": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputHypothesis"
        }
      },
      "signals": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputSignal"
        }
      },
      "interviews": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputInterview"
        }
      },
      "experiments": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputExperiment"
        }
      },
      "commitmentEvidence": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputCommitmentEvidence"
        }
      },
      "minimumPaidOffer": {
        "$ref": "#/components/schemas/OutputMinimumPaidOffer"
      },
      "decision": {
        "$ref": "#/components/schemas/OutputDecision"
      },
      "id": {
        "type": "string"
      },
      "workspaceId": {
        "type": "string"
      },
      "title": {
        "type": "string"
      },
      "rawCapture": {
        "type": "string"
      },
      "state": {
        "$ref": "#/components/schemas/OutputOpportunityState"
      },
      "stateBeforePause": {
        "anyOf": [
          {
            "type": "string",
            "const": "captured"
          },
          {
            "type": "string",
            "const": "framed"
          },
          {
            "type": "string",
            "const": "researching"
          },
          {
            "type": "string",
            "const": "interviewing"
          },
          {
            "type": "string",
            "const": "evaluating"
          },
          {
            "type": "string",
            "const": "offer_ready"
          },
          {
            "type": "string",
            "const": "decided"
          }
        ]
      },
      "pauseReason": {
        "type": "string"
      },
      "abandonmentReason": {
        "type": "string"
      },
      "evidenceLevel": {
        "$ref": "#/components/schemas/OutputEvidenceLevel"
      },
      "streamVersion": {
        "type": "number"
      },
      "createdAt": {
        "type": "string"
      },
      "updatedAt": {
        "type": "string"
      }
    }
  },
  "OutputOpportunityViewV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "title",
      "workspaceId",
      "id",
      "streamVersion",
      "createdAt",
      "updatedAt",
      "hypotheses",
      "signals",
      "experiments",
      "commitmentEvidence",
      "rawCapture",
      "state",
      "evidenceLevel",
      "interviews"
    ],
    "properties": {
      "decision": {
        "$ref": "#/components/schemas/OutputDecision"
      },
      "title": {
        "type": "string"
      },
      "workspaceId": {
        "type": "string"
      },
      "id": {
        "type": "string"
      },
      "streamVersion": {
        "type": "number"
      },
      "createdAt": {
        "type": "string"
      },
      "updatedAt": {
        "type": "string"
      },
      "hypotheses": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputHypothesis"
        }
      },
      "signals": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputSignal"
        }
      },
      "experiments": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputExperiment"
        }
      },
      "commitmentEvidence": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputCommitmentEvidence"
        }
      },
      "minimumPaidOffer": {
        "$ref": "#/components/schemas/OutputMinimumPaidOffer"
      },
      "rawCapture": {
        "type": "string"
      },
      "state": {
        "$ref": "#/components/schemas/OutputOpportunityState"
      },
      "stateBeforePause": {
        "anyOf": [
          {
            "type": "string",
            "const": "captured"
          },
          {
            "type": "string",
            "const": "framed"
          },
          {
            "type": "string",
            "const": "researching"
          },
          {
            "type": "string",
            "const": "interviewing"
          },
          {
            "type": "string",
            "const": "evaluating"
          },
          {
            "type": "string",
            "const": "offer_ready"
          },
          {
            "type": "string",
            "const": "decided"
          }
        ]
      },
      "pauseReason": {
        "type": "string"
      },
      "abandonmentReason": {
        "type": "string"
      },
      "evidenceLevel": {
        "$ref": "#/components/schemas/OutputEvidenceLevel"
      },
      "interviews": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "id",
            "opportunityId",
            "participantRef",
            "occurredAt",
            "rawRecordAssetId",
            "recordedAt",
            "recordedBy",
            "annotations",
            "rawRecord"
          ],
          "properties": {
            "id": {
              "type": "string"
            },
            "opportunityId": {
              "type": "string"
            },
            "participantRef": {
              "type": "string"
            },
            "occurredAt": {
              "type": "string"
            },
            "rawRecordAssetId": {
              "type": "string"
            },
            "recordedAt": {
              "type": "string"
            },
            "recordedBy": {
              "type": "string"
            },
            "annotations": {
              "type": "array",
              "items": {
                "$ref": "#/components/schemas/OutputInterviewAnnotation"
              }
            },
            "rawRecord": {
              "type": "string"
            }
          }
        }
      }
    }
  },
  "OutputOpcDeliverableV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "kind",
      "title",
      "summary",
      "validationStatus",
      "nextAction",
      "content"
    ],
    "properties": {
      "kind": {
        "type": "string"
      },
      "title": {
        "type": "string"
      },
      "summary": {
        "type": "string"
      },
      "validationStatus": {
        "type": "string"
      },
      "nextAction": {
        "type": "string"
      },
      "content": {
        "$ref": "#/components/schemas/OutputJsonObject"
      }
    }
  },
  "OutputStoredOpcDeliverableV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "workspaceId",
      "pluginId",
      "threadId",
      "kind",
      "title",
      "summary",
      "assetIds",
      "id",
      "tenantId",
      "streamVersion",
      "createdAt",
      "updatedAt",
      "validationStatus",
      "content"
    ],
    "properties": {
      "workspaceId": {
        "type": "string"
      },
      "pluginId": {
        "type": "string"
      },
      "threadId": {
        "type": "string"
      },
      "executionId": {
        "type": "string"
      },
      "kind": {
        "type": "string"
      },
      "title": {
        "type": "string"
      },
      "summary": {
        "type": "string"
      },
      "assetIds": {
        "type": "array",
        "items": {
          "type": "string"
        }
      },
      "nextAction": {
        "type": "string"
      },
      "id": {
        "type": "string"
      },
      "tenantId": {
        "type": "string"
      },
      "streamVersion": {
        "type": "number"
      },
      "createdAt": {
        "type": "string"
      },
      "updatedAt": {
        "type": "string"
      },
      "validationStatus": {
        "type": "string"
      },
      "content": {
        "$ref": "#/components/schemas/OutputJsonObject"
      }
    }
  },
  "OutputReadOnlySampleV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "pluginId",
      "effectClass",
      "status",
      "summary"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "pluginId": {
        "anyOf": [
          {
            "type": "string",
            "const": "opc"
          },
          {
            "type": "string",
            "const": "coding"
          }
        ]
      },
      "effectClass": {
        "anyOf": [
          {
            "type": "string",
            "const": "local_read"
          },
          {
            "type": "string",
            "const": "external_read"
          }
        ]
      },
      "status": {
        "type": "string",
        "const": "completed"
      },
      "summary": {
        "type": "string"
      }
    }
  },
  "OutputCodingRepositoryV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "workspaceId",
      "name",
      "rootRealPath",
      "vcs",
      "createdAt",
      "streamVersion",
      "updatedAt"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "workspaceId": {
        "type": "string"
      },
      "name": {
        "type": "string"
      },
      "rootRealPath": {
        "type": "string"
      },
      "vcs": {
        "type": "string",
        "const": "git"
      },
      "createdAt": {
        "type": "string"
      },
      "streamVersion": {
        "type": "number"
      },
      "updatedAt": {
        "type": "string"
      }
    }
  },
  "OutputCodingTaskStatusV2": {
    "anyOf": [
      {
        "type": "string",
        "const": "waiting_approval"
      },
      {
        "type": "string",
        "const": "needs_reconciliation"
      },
      {
        "type": "string",
        "const": "completed"
      },
      {
        "type": "string",
        "const": "failed"
      },
      {
        "type": "string",
        "const": "cancelled"
      },
      {
        "type": "string",
        "const": "active"
      },
      {
        "type": "string",
        "const": "needs_human_decision"
      }
    ]
  },
  "OutputCodingTaskSummaryV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "title",
      "repository",
      "status",
      "checks",
      "nextAction"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "title": {
        "type": "string"
      },
      "repository": {
        "type": "string"
      },
      "status": {
        "$ref": "#/components/schemas/OutputCodingTaskStatusV2"
      },
      "diffSummary": {
        "type": "string"
      },
      "diff": {
        "type": "string"
      },
      "checks": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "name",
            "status"
          ],
          "properties": {
            "name": {
              "type": "string"
            },
            "status": {
              "anyOf": [
                {
                  "type": "string",
                  "const": "pending"
                },
                {
                  "type": "string",
                  "const": "pass"
                },
                {
                  "type": "string",
                  "const": "fail"
                }
              ]
            }
          }
        }
      },
      "approval": {
        "type": "string"
      },
      "nextAction": {
        "type": "string"
      },
      "advanced": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "harnessDigest",
          "candidateCount",
          "remainingBudget"
        ],
        "properties": {
          "harnessDigest": {
            "type": "string"
          },
          "candidateCount": {
            "type": "number"
          },
          "remainingBudget": {
            "type": "string"
          }
        }
      }
    }
  },
  "OutputCodingTaskV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "workspaceId",
      "repositoryId",
      "title",
      "request",
      "stage",
      "status",
      "streamVersion",
      "createdAt",
      "updatedAt"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "workspaceId": {
        "type": "string"
      },
      "repositoryId": {
        "type": "string"
      },
      "title": {
        "type": "string"
      },
      "request": {
        "type": "string"
      },
      "stage": {
        "anyOf": [
          {
            "type": "string",
            "const": "discover"
          },
          {
            "type": "string",
            "const": "specify"
          },
          {
            "type": "string",
            "const": "impact"
          },
          {
            "type": "string",
            "const": "implement"
          },
          {
            "type": "string",
            "const": "verify"
          },
          {
            "type": "string",
            "const": "approve"
          },
          {
            "type": "string",
            "const": "learn"
          }
        ]
      },
      "status": {
        "$ref": "#/components/schemas/OutputCodingTaskStatusV2"
      },
      "streamVersion": {
        "type": "number"
      },
      "createdAt": {
        "type": "string"
      },
      "updatedAt": {
        "type": "string"
      }
    }
  },
  "OutputCodingRunnerViewV2": {
    "anyOf": [
      {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "runnerId",
          "external",
          "status"
        ],
        "properties": {
          "runnerId": {
            "type": "string",
            "const": "builtin"
          },
          "external": {
            "type": "boolean",
            "const": false
          },
          "status": {
            "type": "string",
            "const": "ready"
          }
        }
      },
      {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "runnerId",
          "external",
          "status"
        ],
        "properties": {
          "runnerId": {
            "anyOf": [
              {
                "type": "string",
                "const": "claude-cli"
              },
              {
                "type": "string",
                "const": "codex-cli"
              }
            ]
          },
          "external": {
            "type": "boolean",
            "const": true
          },
          "status": {
            "type": "string",
            "const": "not_configured"
          }
        }
      },
      {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "workspaceId",
          "runnerId",
          "status",
          "identity",
          "identityDigest",
          "confirmedBy",
          "confirmedAt",
          "id",
          "tenantId",
          "streamVersion",
          "createdAt",
          "updatedAt",
          "external"
        ],
        "properties": {
          "workspaceId": {
            "type": "string"
          },
          "runnerId": {
            "$ref": "#/components/schemas/OutputExternalCodingRunnerId"
          },
          "status": {
            "type": "string",
            "const": "confirmed"
          },
          "identity": {
            "$ref": "#/components/schemas/OutputRunnerBinaryIdentityV1"
          },
          "identityDigest": {
            "type": "string"
          },
          "confirmedBy": {
            "type": "string"
          },
          "confirmedAt": {
            "type": "string"
          },
          "id": {
            "type": "string"
          },
          "tenantId": {
            "type": "string"
          },
          "streamVersion": {
            "type": "number"
          },
          "createdAt": {
            "type": "string"
          },
          "updatedAt": {
            "type": "string"
          },
          "external": {
            "type": "boolean",
            "const": true
          }
        }
      }
    ]
  },
  "OutputRunnerBinaryInspectionV1": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "requestedPath",
      "realPath",
      "sha256",
      "device",
      "inode",
      "byteLength",
      "modifiedAtMs"
    ],
    "properties": {
      "requestedPath": {
        "type": "string"
      },
      "realPath": {
        "type": "string"
      },
      "sha256": {
        "type": "string"
      },
      "device": {
        "type": "string"
      },
      "inode": {
        "type": "string"
      },
      "byteLength": {
        "type": "number"
      },
      "modifiedAtMs": {
        "type": "number"
      }
    }
  },
  "OutputCodingReconciliationEvidenceV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "candidateCount",
      "gateCount",
      "markCompletedAllowed",
      "summary"
    ],
    "properties": {
      "candidateCount": {
        "type": "number"
      },
      "gateCount": {
        "type": "number"
      },
      "markCompletedAllowed": {
        "anyOf": [
          {
            "type": "boolean",
            "const": false
          },
          {
            "type": "boolean",
            "const": true
          }
        ]
      },
      "codeEvidenceDigest": {
        "type": "string"
      },
      "summary": {
        "type": "string"
      }
    }
  },
  "OutputCodingReconciliationDecisionV2": {
    "anyOf": [
      {
        "type": "string",
        "const": "terminate"
      },
      {
        "type": "string",
        "const": "mark_completed"
      },
      {
        "type": "string",
        "const": "create_new_call"
      }
    ]
  },
  "OutputCodingReconciliationViewV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "executionId",
      "workspaceId",
      "taskTitle",
      "nextStep",
      "runnerId",
      "status",
      "expectedStreamVersion",
      "expectedCodingStreamVersion",
      "evidence",
      "newCall",
      "availableDecisions"
    ],
    "properties": {
      "executionId": {
        "type": "string"
      },
      "workspaceId": {
        "type": "string"
      },
      "taskTitle": {
        "type": "string"
      },
      "nextStep": {
        "type": "string"
      },
      "runnerId": {
        "anyOf": [
          {
            "type": "string",
            "const": "claude-cli"
          },
          {
            "type": "string",
            "const": "codex-cli"
          }
        ]
      },
      "status": {
        "type": "string",
        "const": "needs_reconciliation"
      },
      "expectedStreamVersion": {
        "type": "number"
      },
      "expectedCodingStreamVersion": {
        "type": "number"
      },
      "evidence": {
        "$ref": "#/components/schemas/OutputCodingReconciliationEvidenceV2"
      },
      "newCall": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "allowed",
          "summary"
        ],
        "properties": {
          "allowed": {
            "anyOf": [
              {
                "type": "boolean",
                "const": false
              },
              {
                "type": "boolean",
                "const": true
              }
            ]
          },
          "summary": {
            "type": "string"
          }
        }
      },
      "availableDecisions": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputCodingReconciliationDecisionV2"
        }
      }
    }
  },
  "OutputCodingCandidateV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "taskId",
      "runnerId",
      "sequence",
      "baseRevision",
      "diffDigest",
      "summary",
      "sandbox"
    ],
    "properties": {
      "id": {
        "type": "string"
      },
      "taskId": {
        "type": "string"
      },
      "runnerId": {
        "type": "string"
      },
      "sequence": {
        "type": "number"
      },
      "baseRevision": {
        "type": "string"
      },
      "diffDigest": {
        "type": "string"
      },
      "summary": {
        "type": "string"
      },
      "sandbox": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "enforced",
          "fallbackUsed"
        ],
        "properties": {
          "enforced": {
            "anyOf": [
              {
                "type": "boolean",
                "const": false
              },
              {
                "type": "boolean",
                "const": true
              }
            ]
          },
          "fallbackUsed": {
            "anyOf": [
              {
                "type": "boolean",
                "const": false
              },
              {
                "type": "boolean",
                "const": true
              }
            ]
          },
          "evidenceDigest": {
            "type": "string"
          }
        }
      }
    }
  },
  "OutputCodingGateV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "candidateId",
      "status",
      "authoritative",
      "checks"
    ],
    "properties": {
      "candidateId": {
        "type": "string"
      },
      "status": {
        "anyOf": [
          {
            "type": "string",
            "const": "failed"
          },
          {
            "type": "string",
            "const": "passed"
          }
        ]
      },
      "authoritative": {
        "anyOf": [
          {
            "type": "boolean",
            "const": false
          },
          {
            "type": "boolean",
            "const": true
          }
        ]
      },
      "evidenceDigest": {
        "type": "string"
      },
      "checks": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": [
            "id",
            "status",
            "summary"
          ],
          "properties": {
            "id": {
              "type": "string"
            },
            "status": {
              "anyOf": [
                {
                  "type": "string",
                  "const": "failed"
                },
                {
                  "type": "string",
                  "const": "passed"
                },
                {
                  "type": "string",
                  "const": "missing"
                },
                {
                  "type": "string",
                  "const": "error"
                }
              ]
            },
            "summary": {
              "type": "string"
            }
          }
        }
      },
      "reason": {
        "type": "string"
      }
    }
  },
  "OutputCodeEvidenceV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "specDigest",
      "governanceDigest",
      "harnessDigest",
      "sandboxDigest",
      "repositoryIndexDigest",
      "taskId",
      "candidateId",
      "runnerId",
      "gateEvidenceDigest",
      "diffDigest",
      "digest"
    ],
    "properties": {
      "specDigest": {
        "type": "string"
      },
      "governanceDigest": {
        "type": "string"
      },
      "harnessDigest": {
        "type": "string"
      },
      "sandboxDigest": {
        "type": "string"
      },
      "repositoryIndexDigest": {
        "type": "string"
      },
      "taskId": {
        "type": "string"
      },
      "candidateId": {
        "type": "string"
      },
      "runnerId": {
        "type": "string"
      },
      "gateEvidenceDigest": {
        "type": "string"
      },
      "diffDigest": {
        "type": "string"
      },
      "digest": {
        "type": "string"
      }
    }
  },
  "OutputCodingControlPlaneV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "protocol",
      "specDigest",
      "governanceDigest",
      "harnessDigest",
      "sandboxDigest",
      "repositoryIndexDigest"
    ],
    "properties": {
      "protocol": {
        "type": "string",
        "const": "coding-v2"
      },
      "specDigest": {
        "type": "string"
      },
      "governanceDigest": {
        "type": "string"
      },
      "harnessDigest": {
        "type": "string"
      },
      "sandboxDigest": {
        "type": "string"
      },
      "repositoryIndexDigest": {
        "type": "string"
      }
    }
  },
  "OutputCodingResultV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "task",
      "runnerId",
      "status",
      "candidates",
      "gates",
      "nextStep",
      "limits",
      "controlPlane"
    ],
    "properties": {
      "task": {
        "$ref": "#/components/schemas/OutputCodingTaskV2"
      },
      "runnerId": {
        "type": "string"
      },
      "status": {
        "anyOf": [
          {
            "type": "string",
            "const": "waiting_approval"
          },
          {
            "type": "string",
            "const": "needs_reconciliation"
          },
          {
            "type": "string",
            "const": "completed"
          },
          {
            "type": "string",
            "const": "failed"
          },
          {
            "type": "string",
            "const": "cancelled"
          },
          {
            "type": "string",
            "const": "needs_human_decision"
          }
        ]
      },
      "candidates": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputCodingCandidateV2"
        }
      },
      "gates": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/OutputCodingGateV2"
        }
      },
      "evidence": {
        "$ref": "#/components/schemas/OutputCodeEvidenceV2"
      },
      "approval": {
        "anyOf": [
          {
            "type": "string",
            "const": "pending"
          },
          {
            "type": "string",
            "const": "approved_once"
          },
          {
            "type": "string",
            "const": "denied"
          }
        ]
      },
      "deliverable": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "kind",
          "title",
          "summary",
          "diffDigest",
          "nextStep"
        ],
        "properties": {
          "kind": {
            "type": "string",
            "const": "code_change"
          },
          "title": {
            "type": "string"
          },
          "summary": {
            "type": "string"
          },
          "diffDigest": {
            "type": "string"
          },
          "nextStep": {
            "type": "string"
          }
        }
      },
      "nextStep": {
        "type": "string"
      },
      "limits": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "maxRepairAttempts",
          "maxDurationMs"
        ],
        "properties": {
          "maxRepairAttempts": {
            "type": "number"
          },
          "maxDurationMs": {
            "type": "number"
          }
        }
      },
      "controlPlane": {
        "$ref": "#/components/schemas/OutputCodingControlPlaneV2"
      }
    }
  },
  "OutputCodingReconciliationResultV2": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "decision",
      "status",
      "execution",
      "codingExecution",
      "task"
    ],
    "properties": {
      "decision": {
        "$ref": "#/components/schemas/OutputCodingReconciliationDecisionV2"
      },
      "status": {
        "anyOf": [
          {
            "type": "string",
            "const": "settled"
          },
          {
            "type": "string",
            "const": "verification_pending"
          }
        ]
      },
      "execution": {
        "$ref": "#/components/schemas/OutputExecution"
      },
      "codingExecution": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "executionId",
          "status",
          "streamVersion",
          "result"
        ],
        "properties": {
          "executionId": {
            "type": "string"
          },
          "status": {
            "anyOf": [
              {
                "type": "string",
                "const": "waiting_approval"
              },
              {
                "type": "string",
                "const": "needs_reconciliation"
              },
              {
                "type": "string",
                "const": "completed"
              },
              {
                "type": "string",
                "const": "failed"
              },
              {
                "type": "string",
                "const": "cancelled"
              },
              {
                "type": "string",
                "const": "needs_human_decision"
              }
            ]
          },
          "streamVersion": {
            "type": "number"
          },
          "result": {
            "$ref": "#/components/schemas/OutputCodingResultV2"
          }
        }
      },
      "task": {
        "$ref": "#/components/schemas/OutputCodingTaskV2"
      },
      "cleanupJobId": {
        "type": "string"
      },
      "verificationJobId": {
        "type": "string"
      },
      "newExecution": {
        "$ref": "#/components/schemas/OutputExecution"
      }
    }
  }
};
