---
layout: post
title: Plotting lineage persistence with Bokeh
---

These plots can be useful for exploring trends in infectious disease outbreaks over time. In some recent work on [bugs growing in hospital sinks](https://www.biorxiv.org/content/10.1101/2020.02.19.952366v3), I used the one below to help show that sink drains are colonised by a handful of *E. coli* lineages, which occasionally overlap with infections seen in patients staying on the same wards. This is a small dataset, but the interactivity of [Bokeh](https://bokeh.org/) is proving useful for exploring a larger version of this dataset, where room for annotations is limited. The code below clusters a dataframe of SNP distances (produced here from a [recombination adjusted SNP phylogeny]({{site.baseurl}}/assets/2020-03-02/in/cluster_1_cf_scaled.guids.tree)), and uses a [dataframe of sampling dates]({{site.baseurl}}/assets/2020-03-02/in/meta.tsv) to produce a plot much like the one below.

{% include 2020-03-02/ec_100_nr.html %}


```python
# Python 3.7 with pandas, bokeh, scipy and treeswift
import pandas as pd
import treeswift as ts

from scipy.spatial.distance import squareform
from scipy.cluster.hierarchy import fcluster, linkage

from bokeh.models import DatetimeTickFormatter, HoverTool, LabelSet
from bokeh.plotting import figure, show, ColumnDataSource
from bokeh.transform import factor_cmap, factor_mark
from bokeh.io import output_notebook, export_svgs
from bokeh.models.ranges import DataRange1d

wd = 'res/2020-03-02'  # working directory

output_notebook()
```



## Load metadata


```python
meta_df = pd.read_csv(f'{wd}/in/meta.tsv', sep='\t', index_col=0, parse_dates=True)
meta_df['date'] = pd.to_datetime(meta_df['date'])
meta_df.head()
```




<div style="overflow-x:auto;">
<table border="1" class="dataframe">
  <thead>
    <tr style="text-align: right;">
      <th></th>
      <th>name</th>
      <th>date</th>
      <th>ward</th>
      <th>sink</th>
      <th>timepoint</th>
      <th>type</th>
      <th>mlst_unknown</th>
    </tr>
    <tr>
      <th>guid</th>
      <th></th>
      <th></th>
      <th></th>
      <th></th>
      <th></th>
      <th></th>
      <th></th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <th>5b6f3b49-81d1-4bda-93e8-b8639d15e332</th>
      <td>pi_ec_9446323_UC_7B_7B_26/03/2017</td>
      <td>2017-03-26</td>
      <td>GM</td>
      <td>NaN</td>
      <td>NaN</td>
      <td>patient</td>
      <td>ecoli 144</td>
    </tr>
    <tr>
      <th>ecb5f5c6-eba4-45d8-b32b-9a03a88cec1c</th>
      <td>pi_ec_1262305_UC_EAU_EAU_27/03/2017</td>
      <td>2017-03-27</td>
      <td>AA</td>
      <td>NaN</td>
      <td>NaN</td>
      <td>patient</td>
      <td>ecoli 127</td>
    </tr>
    <tr>
      <th>fec51366-f5a9-4ad4-882d-1a16b711f460</th>
      <td>pi_ec_1801612_UC_EAU_7C_01/04/2017</td>
      <td>2017-04-01</td>
      <td>AA</td>
      <td>NaN</td>
      <td>NaN</td>
      <td>patient</td>
      <td>ecoli 131</td>
    </tr>
    <tr>
      <th>7e7500f3-f89c-4769-9054-00c705cf3168</th>
      <td>pi_ec_1269762_UC_EAU_SSIP_14/04/2017</td>
      <td>2017-04-14</td>
      <td>AA</td>
      <td>NaN</td>
      <td>NaN</td>
      <td>patient</td>
      <td>ecoli 131</td>
    </tr>
    <tr>
      <th>e69dd351-d716-41b2-bf6b-78e22b1cb461</th>
      <td>pi_ec_1957587_UC_EAU_EAU_14/04/2017</td>
      <td>2017-04-14</td>
      <td>AA</td>
      <td>NaN</td>
      <td>NaN</td>
      <td>patient</td>
      <td>ecoli 73</td>
    </tr>
  </tbody>
</table>
</div>



## Load core phylogeny & fetch recombination adjusted SNP distances


```python
tree = (ts.read_tree_newick(f'{wd}/in/cluster_1_cf_scaled.guids.tree')
        .extract_tree_without({'reference'}))  # Get Tree without reference sequence
distances = tree.distance_matrix(leaf_labels=True)  # Pairwise distances as dict
distances_df = (pd.DataFrame(distances)   # Pairwise distances as square dataframe
                .sort_index(axis=0)
                .sort_index(axis=1)
                .fillna(0)
                .astype(int))
```


```python
distances_df.iloc[:4,:4]
```




<div>
<table border="1" class="dataframe">
  <thead>
    <tr style="text-align: right;">
      <th></th>
      <th>02080367-872a-47fa-9412-a3eefb7cfb86</th>
      <th>03297834-8d15-44e4-bd0d-38a0e234f8b5</th>
      <th>03d85ba8-d254-4188-86bc-e97cf1f3c7c7</th>
      <th>03ee2b1b-5658-4dad-a933-9bc457654c18</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <th>02080367-872a-47fa-9412-a3eefb7cfb86</th>
      <td>0</td>
      <td>26</td>
      <td>67</td>
      <td>21265</td>
    </tr>
    <tr>
      <th>03297834-8d15-44e4-bd0d-38a0e234f8b5</th>
      <td>26</td>
      <td>0</td>
      <td>47</td>
      <td>21245</td>
    </tr>
    <tr>
      <th>03d85ba8-d254-4188-86bc-e97cf1f3c7c7</th>
      <td>67</td>
      <td>47</td>
      <td>0</td>
      <td>21242</td>
    </tr>
    <tr>
      <th>03ee2b1b-5658-4dad-a933-9bc457654c18</th>
      <td>21265</td>
      <td>21245</td>
      <td>21242</td>
      <td>0</td>
    </tr>
  </tbody>
</table>
</div>



## Cluster isolates by SNP distance


```python
snp_threshold = 100
distances_cnd = squareform(distances_df)
clusters = fcluster(linkage(distances_cnd, metric='precomputed'),
                    criterion='distance',
                    t=snp_threshold)
names_clusters = {g:c for g, c in zip(distances_df.columns, clusters)}
```

### (Alternatively, one could use e.g. DBSCAN for clustering)


```python
from sklearn.cluster import DBSCAN
clustering = (DBSCAN(eps=100, min_samples=1, metric='precomputed')
              .fit(distances_df.values))
clusters = clustering.labels_
names_clusters = {n: c for n, c in zip(distances_df.columns, clusters)}
```

### Reorder clusters by date of appearance


```python
clusters_meta_df = meta_df.copy()
clusters_meta_df['cluster'] = clusters_meta_df.index.map(names_clusters)
clusters_meta_df.sort_values('date', inplace=True)

clusters_newclusters = {}
cluster_appearance = [r['cluster'] for r in clusters_meta_df.to_dict('records')]
i = 0
for c in cluster_appearance:
    if c not in clusters_newclusters:
        clusters_newclusters[c] = i
        i += 1
clusters_meta_df['cluster_new'] = clusters_meta_df['cluster'].map(clusters_newclusters)
```

## First try


```python
p = figure()

p.scatter('date',
          'cluster_new',
          source=ColumnDataSource(clusters_meta_df),
          legend_group='ward',
          fill_alpha=0.25,
          line_width=1.5,
          size=9,
          marker=factor_mark('type', ('square', 'circle'), ('patient', 'sink')),
          color=factor_cmap('ward', 'Category10_7',
                            sorted(clusters_meta_df.ward.unique())))

p.xaxis.formatter = DatetimeTickFormatter(days = ['%Y-%m-%d'])

show(p)
```

{% include 2020-03-02/1.html %}



## With cluster lifetimes


```python
# Remove redundant clusters cultured from the same sink-timepoint
clusters_meta_sinks_nr_df = clusters_meta_df.query("type == 'sink'").drop_duplicates(['sink', 'cluster_new', 'date'])
clusters_meta_patients_df = clusters_meta_df.query("type == 'patient'")
clusters_meta_df = pd.concat([clusters_meta_sinks_nr_df, clusters_meta_patients_df])

clusters_startdates = {}
for r in clusters_meta_df.to_dict('records'):
    if r['cluster_new'] in clusters_startdates:
        if r['date'] < clusters_startdates[r['cluster_new']]:
            clusters_startdates[r['cluster_new']] = r['date']
    else:
        clusters_startdates[r['cluster_new']] = r['date']
clusters_enddates = {}
for r in clusters_meta_df.to_dict('records'):
    if r['cluster_new'] in clusters_enddates:
        if r['date'] > clusters_enddates[r['cluster_new']]:
            clusters_enddates[r['cluster_new']] = r['date']
    else:
        clusters_enddates[r['cluster_new']] = r['date']
clusters_lifetimes = {c: (sd, clusters_enddates[c])
                      for c, sd in clusters_startdates.items()}
clusters_lifetimes_len = {c: ed-sd for c, (sd, ed) in clusters_lifetimes.items()}
clusters_meta_df['cluster_lifetime'] = clusters_meta_df['cluster_new'].map(clusters_lifetimes_len)


p = figure()

p.scatter('date',
          'cluster_new',
          source=ColumnDataSource(clusters_meta_df),
          legend_group='ward',
          fill_alpha=0.25,
          line_width=1.5,
          size=9,
          marker=factor_mark('type', ('square', 'circle'), ('patient', 'sink')),
          color=factor_cmap('ward', 'Category10_7',
          sorted(clusters_meta_df.ward.unique())))

p.xaxis.formatter = DatetimeTickFormatter(days = ['%Y-%m-%d'])

for c, l in clusters_lifetimes.items():
    p.line(l, [c,c], line_width=1, line_color='gray')

show(p)
```

{% include 2020-03-02/2.html %}

  

## With labels and tooltips

{% raw %}
```python
tooltips = [('Name', '@name'),
            ('Location', '@ward @sink'),
            ('Date', '@date{%F}'),
            ('Cluster', '@cluster (@mlst_unknown)')]

hover = HoverTool(names=['main'],  # Needed to format datetimes in tooltips
                  formatters={"date": "datetime"})

# Avoid clipping top-rightmost ST labels
x_range = DataRange1d(range_padding=0.2,
                      start=1488412800000,
                      range_padding_units='percent')

p = figure(plot_width=600, plot_height=700, x_range=x_range,
           title='E. coli lineage persistence',
           tooltips=tooltips,
           tools=[hover,'save'])

p.scatter('date',
          'cluster_new',
          source=ColumnDataSource(clusters_meta_df),
          name='main',
          legend_group='ward',
          fill_alpha=0.25,
          line_width=1.5,
          size=9,
          marker=factor_mark('type', ('square', 'circle'), ('patient', 'sink')),
          color=factor_cmap('ward', 'Category10_7',
                             sorted(clusters_meta_df.ward.unique())))

for c, l in clusters_lifetimes.items():
    p.line(l, [c,c], line_width=1, line_color='gray')

labels = LabelSet(x='date', y='cluster_new',
                  text='mlst_unknown',
                  level='glyph',
                  text_font_size="7pt",
                  x_offset=7, y_offset=-5,
                  source=(ColumnDataSource(clusters_meta_df.sort_values('date')
                          .drop_duplicates(['cluster_new'], keep='last'))))
p.add_layout(labels)

p.xaxis.formatter = DatetimeTickFormatter(days = ['%Y-%m-%d'])
p.xaxis.axis_label = 'Date'
p.yaxis.axis_label = 'Core SNP cluster'
p.legend.location = "top_left"
p.xgrid.visible = False
p.ygrid.visible = False
p.toolbar.logo = None
p.toolbar_location = None

show(p)
```
{% endraw %}
{% include 2020-03-02/3.html %}

And we arrive where we began, excepting some ugly legend hacks which I'm too embarrassed to share. Let me know if you encounter issues, and please cite our paper if this helps your science! https://doi.org/10.1099/mgen.0.000391](https://www.microbiologyresearch.org/content/journal/mgen/10.1099/mgen.0.000391)
