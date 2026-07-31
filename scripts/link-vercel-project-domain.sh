#!/usr/bin/env bash
set -euo pipefail

: "${VERCEL_TOKEN:?VERCEL_TOKEN is required}"
: "${VERCEL_ORG_ID:?VERCEL_ORG_ID is required}"
: "${VERCEL_PROJECT_ID:?VERCEL_PROJECT_ID is required}"
: "${EXPECTED_VERCEL_PROJECT:?EXPECTED_VERCEL_PROJECT is required}"
: "${DASHBOARD_APEX:?DASHBOARD_APEX is required}"
: "${DASHBOARD_HOST:?DASHBOARD_HOST is required}"

vercel_api_base_url="${VERCEL_API_BASE_URL:-https://api.vercel.com}"
workdir="$(mktemp -d)"
trap 'rm -rf "${workdir}"' EXIT

fail_provider_request() {
  local operation="$1"
  local status="$2"
  local response_file="$3"
  local provider_code
  local provider_message

  provider_code="$(jq --raw-output '
    (.error.code // .code // "unknown")
    | tostring
    | gsub("[\\u0000-\\u001F\\u007F]"; " ")
    | .[0:80]
  ' "${response_file}" 2>/dev/null || printf unknown)"
  provider_message="$(jq --raw-output '
    (.error.message // .message // "Vercel project-domain request failed")
    | tostring
    | gsub("[\\u0000-\\u001F\\u007F]"; " ")
    | .[0:240]
  ' "${response_file}" 2>/dev/null || printf 'Vercel project-domain request failed')"

  provider_code="$(LC_ALL=C printf '%.80s' "${provider_code}")"
  provider_message="$(LC_ALL=C printf '%.240s' "${provider_message}")"

  echo "::error title=Canonical domain ${operation} failed::Vercel project-domain ${operation} failed (HTTP ${status})."
  printf 'Vercel provider code: %s\n' "${provider_code}"
  printf 'Vercel provider message: %s\n' "${provider_message}"
  exit 1
}

fail_local_contract() {
  local operation="$1"
  local message="$2"
  echo "::error title=Canonical domain ${operation} failed::${message}"
  exit 1
}

request_status() {
  local output_file="$1"
  shift
  curl --silent --show-error \
    --output "${output_file}" \
    --write-out '%{http_code}' \
    --header "Authorization: Bearer ${VERCEL_TOKEN}" \
    "$@" || true
}

target_domain_url="${vercel_api_base_url}/v9/projects/${VERCEL_PROJECT_ID}/domains/${DASHBOARD_HOST}?teamId=${VERCEL_ORG_ID}"
target_domain_response="${workdir}/target-domain.json"
target_domain_status="$(request_status "${target_domain_response}" "${target_domain_url}")"

case "${target_domain_status}" in
  200)
    if ! jq --exit-status \
      --arg domain "${DASHBOARD_HOST}" \
      --arg project "${VERCEL_PROJECT_ID}" '
        type == "object"
        and .name == $domain
        and .projectId == $project
      ' "${target_domain_response}" > /dev/null; then
      fail_local_contract \
        "verification" \
        "Vercel returned a contradictory target project-domain record."
    fi
    echo "${DASHBOARD_HOST} is already attached to ${EXPECTED_VERCEL_PROJECT}."
    exit 0
    ;;
  404) ;;
  *) fail_provider_request "discovery" "${target_domain_status}" "${target_domain_response}" ;;
esac

source_project=""
until=""
page_number=0
while :; do
  page_number=$((page_number + 1))
  if [ "${page_number}" -gt 100 ]; then
    fail_local_contract \
      "discovery" \
      "Vercel project-domain discovery exceeded the bounded page limit."
  fi

  apex_domains_url="${vercel_api_base_url}/v1/domains/${DASHBOARD_APEX}/project-domains?teamId=${VERCEL_ORG_ID}&limit=100"
  if [ -n "${until}" ]; then
    apex_domains_url="${apex_domains_url}&until=${until}"
  fi
  apex_response="${workdir}/apex-domains-${page_number}.json"
  apex_status="$(request_status "${apex_response}" "${apex_domains_url}")"
  if [ "${apex_status}" != "200" ]; then
    fail_provider_request "discovery" "${apex_status}" "${apex_response}"
  fi

  if ! jq --exit-status '
    type == "object"
    and (.projectDomains | type == "array")
    and all(.projectDomains[];
      type == "object"
      and (.name | type == "string")
      and (.projectId | type == "string")
    )
    and (.pagination | type == "object")
  ' "${apex_response}" > /dev/null; then
    fail_local_contract \
      "discovery" \
      "Vercel returned a malformed project-domain discovery response."
  fi

  target_count="$(jq --raw-output \
    --arg domain "${DASHBOARD_HOST}" \
    --arg target "${VERCEL_PROJECT_ID}" '
      [.projectDomains[] | select(.name == $domain and .projectId == $target)]
      | length
    ' "${apex_response}")"
  if [ "${target_count}" -ne 0 ]; then
    fail_local_contract \
      "discovery" \
      "Vercel discovery contradicted the exact target-domain lookup."
  fi

  page_sources="$(jq --compact-output \
    --arg domain "${DASHBOARD_HOST}" \
    --arg target "${VERCEL_PROJECT_ID}" '
      [.projectDomains[]
        | select(.name == $domain and .projectId != $target)
        | .projectId]
      | unique
    ' "${apex_response}")"
  page_source_count="$(jq --raw-output 'length' <<< "${page_sources}")"
  if [ "${page_source_count}" -gt 1 ]; then
    fail_local_contract \
      "discovery" \
      "Vercel returned conflicting source projects for the canonical domain."
  fi
  page_source="$(jq --raw-output '.[0] // empty' <<< "${page_sources}")"
  if [ -n "${page_source}" ]; then
    if [[ ! "${page_source}" =~ ^prj_[A-Za-z0-9]+$ ]]; then
      fail_local_contract \
        "discovery" \
        "Vercel returned an invalid source project identity."
    fi
    if [ -n "${source_project}" ] && [ "${source_project}" != "${page_source}" ]; then
      fail_local_contract \
        "discovery" \
        "Vercel returned conflicting source projects across discovery pages."
    fi
    source_project="${page_source}"
  fi

  next_until="$(jq --raw-output '.pagination.next // empty | tostring' "${apex_response}")"
  if [ -z "${next_until}" ]; then
    break
  fi
  case "${next_until}" in
    *[!0-9]*)
      fail_local_contract \
        "discovery" \
        "Vercel returned an invalid project-domain pagination cursor."
      ;;
  esac
  if [ "${next_until}" = "${until}" ]; then
    fail_local_contract \
      "discovery" \
      "Vercel repeated the project-domain pagination cursor."
  fi
  until="${next_until}"
done

request_file="${workdir}/domain-request.json"
response_file="${workdir}/domain-response.json"
if [ -n "${source_project}" ]; then
  jq --null-input --arg projectId "${VERCEL_PROJECT_ID}" \
    '{projectId: $projectId, gitBranch: null}' \
    > "${request_file}"
  domain_url="${vercel_api_base_url}/v1/projects/${source_project}/domains/${DASHBOARD_HOST}/move?teamId=${VERCEL_ORG_ID}"
  operation="move"
else
  jq --null-input --arg name "${DASHBOARD_HOST}" \
    '{name: $name, gitBranch: null}' \
    > "${request_file}"
  domain_url="${vercel_api_base_url}/v10/projects/${VERCEL_PROJECT_ID}/domains?teamId=${VERCEL_ORG_ID}"
  operation="add"
fi

domain_status="$(request_status \
  "${response_file}" \
  --request POST \
  --header "Content-Type: application/json" \
  --data-binary "@${request_file}" \
  "${domain_url}")"
case "${domain_status}" in
  200|201) ;;
  *) fail_provider_request "${operation}" "${domain_status}" "${response_file}" ;;
esac

verification_response="${workdir}/verified-domain.json"
verification_status="$(request_status "${verification_response}" "${target_domain_url}")"
if [ "${verification_status}" != "200" ]; then
  fail_provider_request "verification" "${verification_status}" "${verification_response}"
fi
if ! jq --exit-status \
  --arg domain "${DASHBOARD_HOST}" \
  --arg project "${VERCEL_PROJECT_ID}" '
    type == "object"
    and .name == $domain
    and .projectId == $project
  ' "${verification_response}" > /dev/null; then
  fail_local_contract \
    "verification" \
    "Vercel did not confirm exact target project-domain ownership."
fi

echo "${DASHBOARD_HOST} is attached to ${EXPECTED_VERCEL_PROJECT}."
