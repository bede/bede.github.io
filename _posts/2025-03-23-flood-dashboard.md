---
layout: post
title: A minimal local flood dashboard


---

The village of Muchelney in the Somerset Levels floods often and sometimes [spectacularly](https://www.bbc.co.uk/news/uk-england-somerset-68161288). Climate change is making severe flooding more frequent, and sustained investment in waterways and road infrastructure is needed for the area to remain livable. But minor flooding is routine, submerging low-lying roads to Langport, Thorney and Muchelney Ham for weeks at a time each winter. This complicates the commutes and school runs, and rapidly fluctuating water levels keep the village Facebook group alight with speculation about the passability of roads in various vehicles. A handful of locals make astute predictions using Environment Agency water level data and their knowledge of road heights, but this kind of arithmetic is clearly a job for a computer.

In December I registered [levelslevels.uk](https://levelslevels.uk) and wrote a single page app predicting the depth of water covering six roads around Muchelney using green/amber/red map markers. Green markers indicate dry roads, amber markers those predicted to be submerged by less than 30cm, and red markers anything deeper. Lacking professional survey equipment, I initially estimated road heights by cross-referencing publicly available historical water level data with my own flood photos. Since then, tweaks to road heights have been informed by occasionally wading into floods alongside enthusiatic help from locals Nick, Roderic, and Christoph, among others. Since December, several floods have tested the app's predictions with feedback suggesting that these are generally accurate to ±5cm. On January 28th following sustained heavy rainfall, in one day there were 795 distinct IP addresses in the server access log. The straightforward app is written in Javascript and runs entirely on the client side. The would-be feature I'm missing most is SMS alerts – next winter perhaps.

**Dashboard: [levelslevels.uk](https://levelslevels.uk)**

**Code: [github.com/bede/levelslevels](https://github.com/bede/levelslevels)**

**Field research**
![combined](/assets/2025-03-23/combined.jpg)

**Screenshot from 2025-01-28**
![combined](/assets/2025-03-23/screenshot.png)