"""スプレッドシートをCSVでダウンロード → D1用のSQLに変換
使い方: python3 migrate.py 家計簿.csv > import.sql
        npx wrangler d1 execute kakeibo --remote --file=import.sql
"""
import csv, sys
from datetime import datetime, timedelta

def q(s): return "'" + str(s).replace("'", "''") + "'"
def iso(s):  # '2026/10/16 12:57:30' (JST) -> UTC ISO
    try: d = datetime.strptime(s.strip(), '%Y/%m/%d %H:%M:%S')
    except ValueError: d = datetime.strptime(s.strip()[:10], '%Y/%m/%d')
    return (d - timedelta(hours=9)).isoformat() + 'Z'

rows = list(csv.reader(open(sys.argv[1], encoding='utf-8-sig')))[1:]
for r in rows:
    if not r or not r[0]: continue
    id_, date, store, amount, pay, cat, created, src = r[:8]
    date = datetime.strptime(date.strip(), '%Y/%m/%d').strftime('%Y-%m-%d')
    amount = int(float(amount.replace(',', '').replace('¥', '') or 0))
    print(f"INSERT OR IGNORE INTO records VALUES ({q(id_)},{q(date)},{q(store)},{amount},{q(pay)},{q(cat)},{q(iso(created))},{q(src)});")
