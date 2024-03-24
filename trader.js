import axios from 'axios'
import fs from 'fs'
import dijkstra from 'dijkstrajs'

// Axios setup
axios.defaults.baseURL = 'https://api.spacetraders.io/v2/'
axios.interceptors.response.use(response => {
    console.log(`${response.status} ${response.config.method.toUpperCase()} ${response.config.url}`)
    return response
})

// Agent registration
const resetDate = (await axios.get('/')).data.resetDate
const CALLSIGN = resetDate.split('').reduce((a,c) => 7747357921*(a + c.charCodeAt(0))%5654646467,0).toString(36).slice(0,4).toUpperCase()
const data_dir = `./data/${resetDate}/${CALLSIGN}`
if (!fs.existsSync(data_dir)) fs.mkdirSync(data_dir, { recursive: true })
if (!fs.existsSync(`${data_dir}/registration.json`)) {
    const faction = ['COSMIC', 'GALACTIC', 'QUANTUM', 'DOMINION', 'ASTRO'][Math.floor(Math.random() * 5)]
    const registration = (await axios.post('/register', { faction, symbol: CALLSIGN })).data.data
    fs.writeFileSync(`${data_dir}/registration.json`, JSON.stringify(registration, null, 2))
}
const registration = JSON.parse(fs.readFileSync(`${data_dir}/registration.json`))
axios.defaults.headers.common['Authorization'] = `Bearer ${registration.token}`

// Ship + market loading
const ship = ((await axios.get('/my/ships')).data.data)[0]
const market_waypoints = [...(await axios.get(`/systems/${ship.nav.systemSymbol}/waypoints?traits=MARKETPLACE&limit=20`)).data.data,
    ...(await axios.get(`/systems/${ship.nav.systemSymbol}/waypoints?traits=MARKETPLACE&page=2&limit=20`)).data.data]
for (const w of market_waypoints) {
    if (!fs.existsSync(`${data_dir}/remote-market-${w.symbol}.json`)) {
        const data = (await axios.get(`/systems/${ship.nav.systemSymbol}/waypoints/${w.symbol}/market`)).data.data
        fs.writeFileSync(`${data_dir}/remote-market-${w.symbol}.json`, JSON.stringify(data, null, 2))
    }
    w.market_remote = JSON.parse(fs.readFileSync(`${data_dir}/remote-market-${w.symbol}.json`))
    try { w.market_local = JSON.parse(fs.readFileSync(`${data_dir}/local-market-${w.symbol}.json`)) } catch (e) {}
}

// Pathfinding
const graph = {}
for(const a of market_waypoints)
    for (const b of market_waypoints) {
        const distance = Math.round(Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2))
        graph[a.symbol] = graph[a.symbol] ?? {}
        if (2 * distance <= ship.fuel.capacity)
            graph[a.symbol][b.symbol] = Math.round(distance * 12.5/15 + 15)
    }
const goto_waypoint = async (waypointSymbolTarget) => {
    for (const waypointSymbol of dijkstra.find_path(graph, ship.nav.waypointSymbol, waypointSymbolTarget).slice(1)) {
        if (ship.fuel.capacity != ship.fuel.current)
            await dock().then(() => axios.post(`/my/ships/${ship.symbol}/refuel`, { units: ship.fuel.capacity - ship.fuel.current }))
        await orbit()
        Object.assign(ship, (await axios.post(`/my/ships/${ship.symbol}/navigate`, { waypointSymbol })).data.data)
        await sleep(new Date(ship.nav.route.arrival) - Date.now() + 1000)
    }
}

// Actions
const dock = async () => ship.nav.status !== 'DOCKED' && (ship.nav = (await axios.post(`/my/ships/${ship.symbol}/dock`)).data.data.nav)
const orbit = async () => ship.nav.status !== 'IN_ORBIT' && (ship.nav = (await axios.post(`/my/ships/${ship.symbol}/orbit`)).data.data.nav)
const sleep = async (ms) => { console.log('sleeping', ms); return new Promise(resolve => setTimeout(resolve, ms)) }
const update_market = async () => {
    const market = (await axios.get(`/systems/${ship.nav.systemSymbol}/waypoints/${ship.nav.waypointSymbol}/market`)).data.data
    market.timestamp = Date.now()
    fs.writeFileSync(`${data_dir}/local-market-${ship.nav.waypointSymbol}.json`, JSON.stringify(market, null, 2))
    market_waypoints.find(w => w.symbol == ship.nav.waypointSymbol).market_local = market
}

// Trading loop
const f = async () => {
    if (ship.cargo.units == 0) {
        const requires_update = market_waypoints.filter(w => w.market_remote.imports.length != 0 && (w.market_local?.timestamp ?? 0) < Date.now() - 3 * 60 * 60 * 1000)
            .filter(w => w.x ** 2 + w.y ** 2 <= 200 ** 2)
            .sort((a, b) => (a.x - ship.nav.route.destination.x) ** 2 + (a.y - ship.nav.route.destination.y) ** 2 - (b.x - ship.nav.route.destination.x) ** 2 - (b.y - ship.nav.route.destination.y) ** 2)
        if (requires_update.length) return await goto_waypoint(requires_update[0].symbol).then(() => update_market())
        const cur_credits = (await axios.get('/my/agent')).data.data.credits
        let trade = { profit: 0 }
        for (const a of market_waypoints)
            for (const b of market_waypoints)
                for (const good of a.market_local?.tradeGoods ?? []) {
                    const good1 = b.market_local?.tradeGoods.find(g => g.symbol == good.symbol) ?? {}
                    const units = Math.min(ship.cargo.capacity, good.tradeVolume, good1.tradeVolume)
                    const profit = units * (good1.sellPrice - good.purchasePrice)
                    if (profit > trade.profit && good.purchasePrice * units + 5000 <= cur_credits)
                        trade = { profit, src: a.symbol, dest: b.symbol, symbol: good.symbol, units }
                }
        if (trade.profit <= 1000) return await sleep(1000 * 60)
        fs.writeFileSync(`${data_dir}/trade.json`, JSON.stringify(trade, null, 2))
        await goto_waypoint(trade.src).then(() => dock())
        ship.cargo = (await axios.post(`/my/ships/${ship.symbol}/purchase`, trade)).data.data.cargo
        return await update_market()
    }
    const trade = JSON.parse(fs.readFileSync(`${data_dir}/trade.json`))
    await goto_waypoint(trade.dest).then(() => dock())
    ship.cargo = (await axios.post(`/my/ships/${ship.symbol}/sell`, trade)).data.data.cargo // todo: handle falling TV
    await update_market()
}
await axios.patch(`/my/ships/${ship.symbol}/nav`, { flightMode: 'BURN' })
await sleep(new Date(ship.nav.route.arrival) - Date.now() + 1000)
while (true) await f()