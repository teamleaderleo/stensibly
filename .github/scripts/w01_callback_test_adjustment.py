from pathlib import Path

path = Path("test/hosted-auth.test.ts")
text = path.read_text()
old = '''    expect(failed.status).toBe(502);
    expect(requests).toHaveLength(1);
    expect(String(requests[0]?.input)).toBe("https://github.com/login/oauth/access_token");
    const exchangeBody = new URLSearchParams(String(requests[0]?.init?.body));'''
new = '''    expect(failed.status).toBe(502);
    expect(requests).toHaveLength(2);
    expect(requests[0]?.init?.method).toBe("GET");
    expect(String(requests[0]?.input)).toBe("https://github.com/login/oauth/access_token");
    expect(requests[0]?.init?.body).toBeUndefined();
    expect(requests[1]?.init?.method).toBe("POST");
    expect(String(requests[1]?.input)).toBe("https://github.com/login/oauth/access_token");
    const exchangeBody = new URLSearchParams(String(requests[1]?.init?.body));'''
count = text.count(old)
if count != 1:
    raise SystemExit(f"{path}: expected one callback assertion block, found {count}")
path.write_text(text.replace(old, new, 1))
