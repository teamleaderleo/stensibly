from pathlib import Path

applicator = Path(__file__).with_name("apply-oauth-token-reason.py")
source = applicator.read_text()
old = '''def block(value: str) -> str:
    return dedent(value).lstrip("\\n")
'''
new = '''def block(value: str) -> str:
    result = dedent(value).lstrip("\\n")
    if result.startswith("} catch {"):
        prefix = "    "
    elif result.startswith("test(\\\""):
        prefix = "  "
    elif result.startswith("expectFailure("):
        prefix = "    "
    else:
        return result
    return "\\n".join(prefix + line if line else line for line in result.split("\\n"))
'''
if source.count(old) != 1:
    raise SystemExit("unexpected OAuth applicator block helper")
exec(compile(source.replace(old, new, 1), str(applicator), "exec"), {})
