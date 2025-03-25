---
layout: post
title: A minimal local flood dashboard


---

The village of Muchelney in the Somerset Levels floods often and sometimes [spectacularly](https://www.bbc.co.uk/news/uk-england-somerset-68161288). Climate change is making severe flooding more frequent, and sustained investment in waterways and road infrastructure is needed for the area to remain livable. But minor flooding is routine, submerging low-lying roads to Langport, Thorney and Muchelney Ham for weeks at a time each winter. This complicates commutes and school runs, and rapidly fluctuating water levels keep the village Facebook group alight with speculation about the passability of roads in various vehicles. A handful of locals make astute predictions using [Environment Agency water level data](https://check-for-flooding.service.gov.uk/station/3379) and their knowledge of road heights and datum offsets, but this kind of arithmetic is clearly a job for a computer.

In December I registered [levelslevels.uk](https://levelslevels.uk) and wrote a minimal dashboard predicting the depth of water covering six roads around Muchelney using <span style="color:#4CAF50">green</span>/<span style="color:#FFC107">amber</span>/<span style="color:#F44336">red</span> map markers. Green markers indicate dry roads, amber markers those predicted to be submerged by less than 30cm, and red markers anything deeper. Lacking professional survey equipment, I estimated road heights by cross-referencing publicly available historical water level data with my own flood photos. Since then, tweaks to road heights have been informed by occasionally wading into floods alongside enthusiatic help from locals Nick, Roderic, and Christoph, among others. Since December, several floods have tested the dashboard's predictions, and feedback suggests that dashboard predictions are within ±5cm of measurements. Setting road height thresholds is quite subjective however – these roads are far from level in width or length and are slowly sinking into the peat beneath them.

On January 28th following sustained heavy rainfall, in one day there were 795 distinct IP addresses in the server access log. The dashboard runs on the client side, using LocalStorage to cache recent water levels and Plotly.js for visualising the time series. Thanks [Sam](https://sam.wnwrght.co.uk/) for convincing me to make the UI less terrible. The feature I'm missing most is SMS alerts – next winter perhaps.

**Dashboard: [levelslevels.uk](https://levelslevels.uk)**

**Code: [github.com/bede/levelslevels](https://github.com/bede/levelslevels)**

**Field research**
![combined](/assets/2025-03-23/combined.jpg)

**Screenshot from 2025-01-28**
![combined](/assets/2025-03-23/screenshot.png)