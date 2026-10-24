# 中国大陆省级地图数据的生成方法

来源：Natural Earth 10m admin-1 states/provinces（公有领域）。Natural Earth 把台湾（TWN）、香港（HKG）、澳门（MAC）作为独立的 admin-0，
按 `adm0_a3 === 'CHN'` 过滤后天然不含三地。过滤结果里还有一个「西沙群岛」（归属海南），改名为海南后随 -dissolve 并入海南，使结果恰为 31 个省级名。
数据在临时目录里处理（不进仓库），只把结果拷进仓库。`name_zh` 去掉省 / 市 / 自治区后缀即得 31 个短名，无需英文映射表。

```bash
SCR="$(mktemp -d)" && cd "$SCR"
curl -sL -o ne1.zip https://naciscdn.org/naturalearth/10m/cultural/ne_10m_admin_1_states_provinces.zip
unzip -o -q ne1.zip
npx -y mapshaper@0.6 ne_10m_admin_1_states_provinces.shp \
  -filter "adm0_a3 === 'CHN'" \
  -each "name = (name_zh || '').replace(/(壮族自治区|回族自治区|维吾尔自治区|自治区|省|市)$/, '')" \
  -each "name = name === '西沙群岛' ? '海南' : name" \
  -dissolve fields=name \
  -simplify 4% keep-shapes \
  -filter-fields name \
  -rename-layers provinces \
  -o format=topojson quantization=1e5 cn-provinces.json
node -e "const t=require('./cn-provinces.json');const n=t.objects.provinces.geometries.map(g=>g.properties.name).sort();console.log(n.length, n.join(' '))"
cp "$SCR/cn-provinces.json" "<仓库根>/frontend/src/assets/geo/cn-provinces.json"
```

说明：
- mapshaper 里 `-dissolve` 要写 `fields=name`（裸 `name` 会被当成图层名选项而报错）。
- 期望输出 `31` 加 31 个短名，与 `backend/app/services/ip_geo.py` 的 `PROVINCES` 值集合完全一致；不得出现台湾、香港、澳门、西沙群岛或空名（西沙已并入海南）。
- 结果约 24 KB。
