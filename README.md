# כיסוי רשתי – "איזוכרון הפוך" (Inverse Isochrone Network Coverage)

אלגוריתם רשתי למציאת קבוצת מוקדים קטנה ככל האפשר ברשת מרחבית, כך שכל צומת ברשת נמצא במרחק רשתי ≤ r מהמוקד הקרוב אליו – כלומר: קובעים את **המרחק המקסימלי** (במקום את מספר המוקדים) ומחפשים את המוקדים שמכסים את כל השטח.

הפרויקט כולל:

| תיקייה | תוכן |
|---|---|
| [web/](web/) | POC וובי לגמרי (TypeScript, Vite, MapLibre, Web Worker): הורדת רשת OSM לפי מסנני osmnx, פישוט רשתי ב-TS, הרצת האלגוריתמים והדגמה צעד-אחר-צעד |
| [lib/python/netcover.py](lib/python/netcover.py) | אותם אלגוריתמים על גרפים של networkx / osmnx (+ [demo_osmnx.py](lib/python/demo_osmnx.py)) |
| [lib/r/netcover.R](lib/r/netcover.R) | אותם אלגוריתמים על sfnetworks / igraph (+ [demo_tlv.R](lib/r/demo_tlv.R) עם osmdata) |
| [lib/qgis/network_coverage_algorithm.py](lib/qgis/network_coverage_algorithm.py) | סקריפט Processing ל-QGIS (כלים בסיסיים בלבד, ללא תלויות) עם שכבת צעדים ל-Temporal Controller |
| `_ref/` | שיבוט של [idshklein/tlv_walkshed_optimization](https://github.com/idshklein/tlv_walkshed_optimization) לעיון (אפשר למחוק) |

## האלגוריתם המוצע – "משיכה-והוספה" (pull-and-seed)

זהו פורמליזציה של הרעיון שביישום הייחוס (`incremental_add_centers` ב-`index.Rmd`), k-center אינקרמנטלי:

1. **אתחול** – שני מוקדים בקצות הקוטר המשוער של הגרף (או מוקד אחד במרכז, k אקראיים, או בחירה ידנית על המפה).
2. **שיוך** – Dijkstra רב-מקורי מכל המוקדים: כל צומת מקבל את המוקד הקרוב אליו (תאי וורונוי רשתיים).
3. **משיכה** – כל מוקד נמשך אל **1-center** של האשכול שלו (הצומת שממזער את המרחק המקסימלי לחברי האשכול; אפשרות `minisum` → 1-median).
4. **היתקעות** – אם אף מוקד לא זז, הושגה התכנסות מקומית (Lloyd). אם עדיין `max d(v,S) > r`:
5. **הוספה** – מוסיפים מוקד חדש בצומת הרחוק ביותר מכל המוקדים, וחוזרים ל-2.
6. **סיום** כאשר `max d(v,S) ≤ r`. אופציונלי: שיפור-משיכה נוסף וגיזום מוקדים מיותרים.

ביישום הייחוס נעשה שימוש במטריצת מרחקים מלאה (n×n) – לא ישים לרשת עירונית שלמה. כאן ה-1-center של אשכול מחושב **במדויק ללא מטריצה**: שומרים קבוצת "צמתים קיצוניים" E באשכול; `lb(v)=max_{e∈E} d(e,v)` הוא חסם תחתון על האקסצנטריות של v; מעריכים את המועמד עם ה-lb הנמוך ביותר ב-Dijkstra חסום (cutoff = האקסצנטריות הטובה עד כה) ועוצרים כשהחסם התחתון המזערי ≥ הפתרון הטוב. בנוסף, מחושבים מחדש רק אשכולות שההרכב שלהם השתנה מהצעד הקודם. 

## אלגוריתמים נוספים שמודגמים ב-POC

| שיטה | רעיון | מקור |
|---|---|---|
| Gonzalez farthest-first | מוסיפים בכל פעם את הצומת הרחוק ביותר, ללא משיכה. קירוב-2 ל-k-center | Gonzalez 1985 |
| Greedy set cover (LSCP) | לכל מועמד – קבוצת הצמתים בטווח r (Dijkstra חסום); בוחרים חמדנית את המכסה הכי הרבה צמתים חסרים | Toregas et al. 1971; Church & ReVelle 1974 (MCLP) |
| k קבוע – Lloyd רשתי | אותו שלב משיכה ללא הוספה (k-medoids / p-center heuristic); מדווח אם r הושג | Lloyd 1982; Kaufman & Rousseeuw |
| גיזום | הסרת מוקדים מיותרים כל עוד הכיסוי נשמר (רדוקציה של LSCP) | – |

תוצאה אופיינית (תל אביב-יפו, walk, r=500 מ', מקטעים 150 מ', 21.8k צמתים): **משיכה-והוספה 288 מוקדים**, LSCP חמדני 387, Gonzalez 566 – ב-16 שניות ב-Web Worker.

## הרצת ה-POC הוובי

```bash
cd web
npm install
npm run dev        # http://localhost:5173
npm run build      # dist/ סטטי – אפשר להעלות ל-GitHub Pages
```

- **רשת**: שם מקום (Nominatim → פוליגון, כמו `ox.graph_from_place`) או תיבת המפה; סוג רשת `drive / drive_service / walk / bike / all / all_public / all_private` עם המסננים המדויקים של osmnx ל-Overpass; פישוט טופולוגי (כמו `simplify_graph`), איחוד צמתים (כמו `consolidate_intersections`), הרכיב הקשיר הגדול, וחלוקת קשתות למקטעים (כמו `st_network_blend` ביישום הייחוס) – כולם ב-TypeScript ([web/src/graph/osm.ts](web/src/graph/osm.ts)). התגובה של Overpass נשמרת ב-IndexedDB.
- **זמן ריצה**: מוצגת הערכה לפני ההרצה, אזהרה על רשתות גדולות/שטח גדול, תקציב זמן (ברירת מחדל 120 ש') וכפתור עצירה. ההמלצה: walk של עיר שלמה עם מקטע 150 מ' ו-r=500 – עד דקה; לרשתות גדולות להגדיל את אורך המקטע/r או לבחור drive.
- **צעדים**: סרגל זמן, ניגון, חיצי תזוזה, סימון הצומת הרחוק ביותר והמוקד שנוסף, גרף של מרחק מקסימלי ו-k לאורך הצעדים, צביעה לפי אשכול או לפי מרחק, ייצוא GeoJSON של צעד / JSON של כל הצעדים.
- **קישור ישיר**: `?place=Tel%20Aviv-Yafo&type=walk&r=500&algo=pullseed&auto=1` מוריד ומריץ אוטומטית.

בדיקות: `npx tsx scripts/test-grid.ts` (גריד סינתטי), `npx tsx scripts/test-osm.ts "Tel Aviv-Yafo" walk 500` (מסלול הנתונים המלא ב-Node), `node scripts/e2e.mjs` (בדיקת דפדפן עם Edge, צילומי מסך ב-`scripts/shots`).

## Python (networkx / osmnx)

```python
import osmnx as ox, netcover as nc
G = ox.graph_from_place("Tel Aviv-Yafo, Israel", network_type="walk")
H = nc.prepare(ox.project_graph(G), segment_length=150)
steps = nc.pull_and_seed(H, radius=500)          # list[Step] – לאנימציה
centers, nodes = nc.steps_to_geodataframes(H, steps[-1])
```
מימוש Python טהור – פי ~10–20 איטי מה-Worker; `nc.estimate_runtime_seconds` נותן סדר גודל. בדיקה: `python lib/python/test_netcover.py`.

## R (sfnetworks)

```r
source("lib/r/netcover.R")
net   <- nc_prepare(osm_lines, crs = 2039, segment_length = 150)   # subdivision → smooth → blend → רכיב גדול
steps <- nc_pull_and_seed(net, radius = 500)
nc_animate(net, steps, "frames", radius = 500)                      # PNG לכל צעד → gifski
```
בדיקה: `Rscript lib/r/test_netcover.R`.

## QGIS

Processing Toolbox ▸ Scripts ▸ Add Script to Toolbox ▸ `lib/qgis/network_coverage_algorithm.py`. קלט: שכבת קווים בהיטל מטרי (למשל EPSG:2039, מ-QuickOSM). פלט: מוקדים, צמתים (אשכול/מרחק/מכוסה) ושכבת צעדים עם שדה `step` לאנימציה ב-Temporal Controller. בדיקה ללא GUI: `C:\OSGeo4W\bin\python-qgis-ltr.bat lib/qgis/test_qgis_headless.py`.

## מקורות

- Gonzalez, T. F. (1985). Clustering to minimize the maximum intercluster distance. *Theoretical Computer Science*.
- Toregas, C., Swain, R., ReVelle, C., & Bergman, L. (1971). The location of emergency service facilities. *Operations Research*.
- Church, R., & ReVelle, C. (1974). The maximal covering location problem. *Papers of the Regional Science Association*.
- Hochbaum, D. S., & Shmoys, D. B. (1985). A best possible heuristic for the k-center problem. *Mathematics of OR*.
- Likas, A., Vlassis, N., & Verbeek, J. (2003). The global k-means clustering algorithm. *Pattern Recognition*.
- Boeing, G. (2017). OSMnx. *Computers, Environment and Urban Systems*; van der Meer, L. et al. (2023). sfnetworks. *JOSS*.
