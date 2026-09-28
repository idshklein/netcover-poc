# Headless test of the QGIS processing script on a synthetic grid:
#   C:\OSGeo4W\bin\python-qgis-ltr.bat test_qgis_headless.py
import os
import random
import sys
import time

from qgis.core import (QgsApplication, QgsFeature, QgsField, QgsGeometry, QgsPointXY, QgsProject, QgsVectorLayer,
                       QgsProcessingFeedback, QgsProcessingContext)
from qgis.PyQt.QtCore import QVariant

QgsApplication.setPrefixPath(os.environ.get('QGIS_PREFIX_PATH', r'C:\OSGeo4W\apps\qgis-ltr'), True)
app = QgsApplication([], False)
app.initQgis()
sys.path.append(os.path.join(QgsApplication.prefixPath(), 'python', 'plugins'))
import processing  # noqa: E402
from processing.core.Processing import Processing  # noqa: E402
Processing.initialize()

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from network_coverage_algorithm import NetworkCoverageAlgorithm  # noqa: E402

# synthetic grid in EPSG:2039
random.seed(1)
layer = QgsVectorLayer('LineString?crs=EPSG:2039&field=id:integer', 'grid', 'memory')
pr = layer.dataProvider()
n, sp = 30, 100.0
feats = []
for i in range(n):
    for j in range(n):
        x, y = 180000 + j * sp, 660000 + i * sp
        if j + 1 < n and random.random() > 0.15:
            f = QgsFeature(); f.setGeometry(QgsGeometry.fromPolylineXY([QgsPointXY(x, y), QgsPointXY(x + sp, y)])); f.setAttributes([len(feats)]); feats.append(f)
        if i + 1 < n and random.random() > 0.15:
            f = QgsFeature(); f.setGeometry(QgsGeometry.fromPolylineXY([QgsPointXY(x, y), QgsPointXY(x, y + sp)])); f.setAttributes([len(feats)]); feats.append(f)
pr.addFeatures(feats)
QgsProject.instance().addMapLayer(layer)

alg = NetworkCoverageAlgorithm()
alg.initAlgorithm()
ctx = QgsProcessingContext()
ctx.setProject(QgsProject.instance())


class FB(QgsProcessingFeedback):
    def pushInfo(self, s):
        if s.startswith(('graph', 'done', 'final')):
            print(s)


for method in (0, 1, 2):
    t = time.time()
    res = alg.run({'INPUT': layer, 'RADIUS': 500, 'METHOD': method, 'OBJECTIVE': 0, 'SEGMENT': 60, 'TOLERANCE': 0.5,
                   'PRUNE': False, 'CENTERS': 'memory:', 'NODES': 'memory:', 'STEPS': 'memory:'}, ctx, FB())
    out = res[0]
    centers = ctx.takeResultLayer(out['CENTERS'])
    nodes = ctx.takeResultLayer(out['NODES'])
    steps = ctx.takeResultLayer(out['STEPS'])
    print(f'method {method}: {time.time() - t:.1f}s centers={centers.featureCount()} nodes={nodes.featureCount()} step-features={steps.featureCount()}')
    assert all(f["covered"] for f in nodes.getFeatures())
app.exitQgis()
print('OK')
