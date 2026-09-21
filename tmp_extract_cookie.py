import json
with open(r'C:\Users\o_mar\Downloads\Network-novo-sg.har','r',encoding='utf-8') as f:
    data=json.load(f)
cookies=set()
for entry in data['log']['entries']:
    for c in entry['request'].get('cookies',[]):
        cookies.add(f"{c['name']}={c['value']}")
    for h in entry['request'].get('headers',[]):
        if h['name'].lower()=='cookie':
            for part in h['value'].split(';'):
                cookies.add(part.strip())
for c in sorted(cookies):
    if 'auth' in c.lower() or 'session' in c.lower() or 'next' in c.lower():
        print(c)
