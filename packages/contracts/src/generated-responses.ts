// Generated from api-outputs.ts. Do not edit.
// SPDX-License-Identifier: Apache-2.0
import type { JsonObject } from "./json.js";
export const API_OUTPUT_SCHEMAS_V2: Readonly<Record<string, JsonObject>> = {
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
            "const": "needs_reconciliation"
          },
          {
            "type": "string",
            "const": "running"
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
      "version",
      "displayName",
      "description",
      "license",
      "permissions",
      "packageSha256",
      "release",
      "pluginId",
      "trustBoundary"
    ],
    "properties": {
      "version": {
        "type": "string"
      },
      "displayName": {
        "type": "string"
      },
      "description": {
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
        "const": "needs_reconciliation"
      },
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
          "threadId",
          "pluginId"
        ],
        "properties": {
          "threadId": {
            "type": "string"
          },
          "pluginId": {
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
      "status",
      "scopeType",
      "namespace",
      "resourceId",
      "sourceEventId",
      "confidence",
      "shareGrantIds",
      "id",
      "tenantId",
      "streamVersion",
      "createdAt",
      "updatedAt",
      "value"
    ],
    "properties": {
      "workspaceId": {
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
      "namespace": {
        "type": "string"
      },
      "resourceId": {
        "type": "string"
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
      "expiresAt": {
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
            "const": "active"
          },
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
        "const": "pursue"
      },
      {
        "type": "string",
        "const": "revise"
      },
      {
        "type": "string",
        "const": "stop"
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
      "workspaceId",
      "title",
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
      "workspaceId": {
        "type": "string"
      },
      "decision": {
        "$ref": "#/components/schemas/OutputDecision"
      },
      "title": {
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
        "const": "active"
      },
      {
        "type": "string",
        "const": "needs_reconciliation"
      },
      {
        "type": "string",
        "const": "waiting_approval"
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
                  "const": "error"
                },
                {
                  "type": "string",
                  "const": "missing"
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
            "const": "needs_reconciliation"
          },
          {
            "type": "string",
            "const": "waiting_approval"
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
                "const": "needs_reconciliation"
              },
              {
                "type": "string",
                "const": "waiting_approval"
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
