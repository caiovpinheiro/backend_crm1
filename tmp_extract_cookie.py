import json
with open(r'C:\Users\o_mar\Downloads\Network-novo-sg.har','r',encoding='utf-8') as f:
    data=json.load(f)
for entry in data['log']['entries']:
    for h in entry['request']['headers']:
        if h['name'].lower()=='cookie':
            print(h['value'])
            raise SystemExit
print('not found')
