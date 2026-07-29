#!/usr/bin/env python3
"""Apply issue-474 updates to workerd's full generator pipeline fixture."""

from __future__ import annotations

import sys
from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{label}: expected one match, found {count}")
    return text.replace(old, new, 1)


def replace_last(text: str, old: str, new: str, label: str) -> str:
    index = text.rfind(old)
    if index == -1:
        raise RuntimeError(f"{label}: expected a match")
    return text[:index] + new + text[index + len(old) :]


def main() -> int:
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} WORKERD_ROOT", file=sys.stderr)
        return 2

    path = Path(sys.argv[1]) / "types/test/index.spec.ts"
    text = path.read_text()

    text = replace_once(
        text,
        "    const members = eventTarget._initMembers(2);",
        "    const members = eventTarget._initMembers(4);",
        "EventTarget member count",
    )

    text = replace_once(
        text,
        """    method._initReturnType().voidt = true;
  }
  eventTarget.tsDefine = 'interface Event {}';
""",
        """    method._initReturnType().voidt = true;

    const receiverFree = members.get(2)._initMethod();
    receiverFree.name = 'receiverFree';
    receiverFree._initArgs(1).get(0)._initString().name = 'kj::String';
    receiverFree._initReturnType()._initString().name = 'kj::String';

    const detachable = members.get(3)._initMethod();
    detachable.name = 'detachable';
    detachable.static = true;
    detachable._initArgs(1).get(0)._initString().name = 'kj::String';
    detachable._initReturnType()._initString().name = 'kj::String';
  }
  eventTarget.tsDefine = 'interface Event {}';
""",
        "EventTarget generated methods",
    )

    text = replace_once(
        text,
        """  eventTarget.tsOverride = `<EventMap extends Record<string, Event> = Record<string, Event>> {
    addEventListener<Type extends keyof EventMap>(type: Type, handler: (event: EventMap[Type]) => void): void;
  }`;
""",
        """  eventTarget.tsOverride = `<EventMap extends Record<string, Event> = Record<string, Event>> {
    addEventListener<Type extends keyof EventMap>(type: Type, handler: (event: EventMap[Type]) => void): void;
    receiverFree(this: void, value: string): string;
  }`;
""",
        "EventTarget override",
    )

    text = replace_last(
        text,
        "    addEventListener<Type extends keyof EventMap>(type: Type, handler: (event: EventMap[Type]) => void): void;",
        """    addEventListener<Type extends keyof EventMap>(this: EventTarget<EventMap>, type: Type, handler: (event: EventMap[Type]) => void): void;
    receiverFree(this: void, value: string): string;
    static detachable(param0: string): string;""",
        "EventTarget expected output",
    )

    text = replace_once(
        text,
        """interface ServiceWorkerGlobalScope extends WorkerGlobalScope {
    things(param0: boolean): IterableIterator<string>;
    get prop(): Promise<number>;
}
declare function addEventListener<Type extends keyof WorkerGlobalScopeEventMap>(type: Type, handler: (event: WorkerGlobalScopeEventMap[Type]) => void): void;
declare function things(param0: boolean): IterableIterator<string>;
declare const prop: Promise<number>;
""",
        """interface ServiceWorkerGlobalScope extends WorkerGlobalScope {
    things(this: ServiceWorkerGlobalScope | typeof globalThis | null | void, param0: boolean): IterableIterator<string>;
    get prop(): Promise<number>;
}
declare function addEventListener<Type extends keyof WorkerGlobalScopeEventMap>(this: EventTarget<WorkerGlobalScopeEventMap> | typeof globalThis | null | void, type: Type, handler: (event: WorkerGlobalScopeEventMap[Type]) => void): void;
declare function receiverFree(this: void, value: string): string;
declare function detachable(param0: string): string;
declare function things(this: ServiceWorkerGlobalScope | typeof globalThis | null | void, param0: boolean): IterableIterator<string>;
declare const prop: Promise<number>;
""",
        "ServiceWorker global expected output",
    )

    path.write_text(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
