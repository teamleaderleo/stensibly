#!/usr/bin/env python3
"""Project one exact Stensibly item/run/command binding to a private result."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
from pathlib import Path
from typing import Any


SAFE_REF = re.compile(r"^[A-Za-z0-9][A-Za-z0-9:._/@+-]{0,239}$")
SHA256 = re.compile(r"^sha256:[a-f0-9]{64}$")


class SnapshotError(RuntimeError):
    pass


def bounded_ref(value: str, label: str) -> str:
    if not SAFE_REF.fullmatch(value):
        raise SnapshotError(f"{label} is invalid")
    return value


def generation(value: str, label: str, *, minimum: int) -> int:
    if not value.isascii() or not value.isdigit():
        raise SnapshotError(f"{label} is invalid")
    parsed = int(value)
    if parsed < minimum or parsed > 9_007_199_254_740_991:
        raise SnapshotError(f"{label} is invalid")
    return parsed


def connect_readonly(path: Path) -> sqlite3.Connection:
    resolved = path.expanduser().resolve()
    uri = "file:" + str(resolved).replace("?", "%3f").replace("#", "%23") + "?mode=ro"
    connection = sqlite3.connect(uri, uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only = ON")
    return connection


def one_row(connection: sqlite3.Connection, sql: str, value: str, label: str) -> dict[str, Any]:
    rows = connection.execute(sql, (value,)).fetchall()
    if len(rows) != 1:
        raise SnapshotError(f"{label} is missing or ambiguous")
    return dict(rows[0])


def snapshot(args: argparse.Namespace) -> dict[str, Any]:
    project = bounded_ref(args.project, "project")
    item_id = bounded_ref(args.item_id, "item ID")
    run_id = bounded_ref(args.run_id, "run ID")
    holder_id = bounded_ref(args.authority_holder, "authority holder")
    command_id = bounded_ref(args.command_id, "command ID")
    claim_generation = generation(args.claim_generation, "claim generation", minimum=0)
    run_generation = generation(args.run_generation, "run generation", minimum=1)
    lease_generation = generation(args.lease_generation, "lease generation", minimum=1)
    with connect_readonly(args.database) as connection:
        item = one_row(
            connection,
            """
            SELECT id, project_id, status, claim_generation, claimed_by, claim_expires_at
            FROM items WHERE id = ?
            """,
            item_id,
            "item",
        )
        run = one_row(
            connection,
            """
            SELECT id, item_id, runner_type, runner_profile, runner_profile_version,
                   status, generation, lease_generation, lease_owner_id, lease_expires_at
            FROM work_runs WHERE id = ?
            """,
            run_id,
            "run",
        )
        command = one_row(
            connection,
            """
            SELECT command_id, command_fingerprint, request_fingerprint,
                   project_id, item_id, run_id, run_generation, lease_generation,
                   actor_id, adapter_id, profile_id, settlement_json
            FROM runner_adapter_commands WHERE command_id = ?
            """,
            command_id,
            "runner adapter command",
        )

    expected_item = {
        "id": item_id,
        "project_id": project,
        "status": "active",
        "claim_generation": claim_generation,
        "claimed_by": holder_id,
        "claim_expires_at": args.authority_expires_at,
    }
    if item != expected_item:
        raise SnapshotError("item projection changed from the exact command binding")
    if (
        run["id"] != run_id
        or run["item_id"] != item_id
        or run["runner_type"] != "lazy-commander"
        or run["runner_profile"] != args.profile_id
        or run["runner_profile_version"] != args.profile_version
        or run["status"] not in {"starting", "running", "waiting"}
        or run["generation"] != run_generation
        or run["lease_generation"] != lease_generation
        or run["lease_owner_id"] != holder_id
        or run["lease_expires_at"] != args.authority_expires_at
    ):
        raise SnapshotError("run projection changed from the exact command binding")
    if (
        command["command_id"] != command_id
        or not SHA256.fullmatch(str(command["command_fingerprint"]))
        or not SHA256.fullmatch(str(command["request_fingerprint"]))
        or command["project_id"] != project
        or command["item_id"] != item_id
        or command["run_id"] != run_id
        or command["run_generation"] != run_generation
        or command["lease_generation"] != lease_generation
        or command["actor_id"] != holder_id
        or command["adapter_id"] != "lazy-commander"
        or command["profile_id"] != args.profile_id
        or command["settlement_json"] is not None
    ):
        raise SnapshotError("reserved command projection changed before observation")

    identity = {
        "schema": "stensibly-lazy-workstation-snapshot/v1",
        "project": project,
        "itemId": item_id,
        "itemClaimGeneration": claim_generation,
        "runId": run_id,
        "runGeneration": run_generation,
        "leaseGeneration": lease_generation,
        "authorityHolderId": holder_id,
        "authorityExpiresAt": args.authority_expires_at,
        "commandId": command_id,
        "commandFingerprint": command["command_fingerprint"],
        "requestFingerprint": command["request_fingerprint"],
        "profileId": args.profile_id,
        "profileVersion": args.profile_version,
        "observationOnly": True,
        "authorizesWork": False,
        "authorizesEffects": False,
        "authorizesRedispatch": False,
        "rawContentEmitted": False,
    }
    canonical = json.dumps(identity, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
    return {
        **identity,
        "identitySha256": "sha256:" + hashlib.sha256(canonical.encode()).hexdigest(),
    }


def write_private(path: Path, value: dict[str, Any]) -> None:
    payload = (json.dumps(value, ensure_ascii=False, sort_keys=True) + "\n").encode()
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as output:
        output.write(payload)
        output.flush()
        os.fsync(output.fileno())


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(description=__doc__)
    value.add_argument("--database", type=Path, required=True)
    value.add_argument("--project", required=True)
    value.add_argument("--item-id", required=True)
    value.add_argument("--claim-generation", required=True)
    value.add_argument("--run-id", required=True)
    value.add_argument("--run-generation", required=True)
    value.add_argument("--lease-generation", required=True)
    value.add_argument("--authority-holder", required=True)
    value.add_argument("--authority-expires-at", required=True)
    value.add_argument("--command-id", required=True)
    value.add_argument("--profile-id", required=True)
    value.add_argument("--profile-version", required=True)
    value.add_argument("--output", type=Path, required=True)
    return value


def main() -> int:
    args = parser().parse_args()
    bounded_ref(args.profile_id, "profile ID")
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", args.profile_version):
        raise SnapshotError("profile version is invalid")
    if not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", args.authority_expires_at):
        raise SnapshotError("authority expiry is not canonical")
    result = snapshot(args)
    write_private(args.output, result)
    print(json.dumps({"ok": True, "rawContentEmitted": False}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
