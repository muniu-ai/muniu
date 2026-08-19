{{- define "muniu.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- define "muniu.fullname" -}}
{{- if .Values.fullnameOverride }}{{ .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}{{ else }}{{ include "muniu.name" . }}{{ end }}
{{- end }}
{{- define "muniu.labels" -}}
app.kubernetes.io/name: {{ include "muniu.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}
{{- define "muniu.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}{{ default (include "muniu.fullname" .) .Values.serviceAccount.name }}{{ else }}{{ default "default" .Values.serviceAccount.name }}{{ end }}
{{- end }}
{{- define "muniu.image" -}}
{{ printf "%s:%s" .Values.image.repository (.Values.image.tag | default .Chart.AppVersion) }}
{{- end }}
{{- define "muniu.workerServiceAccountName" -}}
{{ printf "%s-worker" (include "muniu.fullname" .) }}
{{- end }}
{{- define "muniu.candidateServiceAccountName" -}}
{{ default (printf "%s-candidate" (include "muniu.fullname" .)) .Values.sandbox.serviceAccountName }}
{{- end }}
{{- define "muniu.sharedWorkspaceClaimName" -}}
{{- if .Values.sandbox.sharedWorkspace.existingClaim }}{{ .Values.sandbox.sharedWorkspace.existingClaim }}{{ else }}{{ printf "%s-sandbox-workspaces" (include "muniu.fullname" .) }}{{ end }}
{{- end }}
