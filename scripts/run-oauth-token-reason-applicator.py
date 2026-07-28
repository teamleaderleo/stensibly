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
source = source.replace(old, new, 1)
needle = 'expect(serialized).toBe(JSON.stringify({ stage }));'
first = source.find(needle)
second = source.find(needle, first + 1)
third = source.find(needle, second + 1)
if first < 0 or second < 0 or third >= 0:
    raise SystemExit("unexpected serialized OAuth failure expectations")
replacement = 'expect(serialized).toBe(JSON.stringify({ stage, ...(reason ? { reason } : {}) }));'
source = source[:second] + replacement + source[second + len(needle):]
exec(compile(source, str(applicator), "exec"), {})
