import axios from 'axios'
import fs from 'fs'
import dijkstra from 'dijkstrajs'

// add axios interceptor to log requests
axios.defaults.baseURL = 'https://api.spacetraders.io/v2/'
axios.interceptors.response.use(response => {
    console.log(`${response.status} ${response.config.method.toUpperCase()} ${response.config.url}`)
    return response
})

// Setup: data directory + agent registration
const CALLSIGN = 'TEST-SDFSDF'
const data_dir = `./data/${(await axios.get('/')).data.resetDate}/${CALLSIGN}`
if (!fs.existsSync(data_dir)) fs.mkdirSync(data_dir, { recursive: true })
if (!fs.existsSync(`${data_dir}/registration.json`)) {
    const faction = ['COSMIC', 'GALACTIC', 'QUANTUM', 'DOMINION', 'ASTRO'][Math.floor(Math.random() * 5)]
    const registration = (await axios.post('/register', { faction, symbol: CALLSIGN })).data.data
    fs.writeFileSync(`${data_dir}/registration.json`, JSON.stringify(registration, null, 2))
}
const registration = JSON.parse(fs.readFileSync(`${data_dir}/registration.json`))
axios.defaults.headers.common['Authorization'] = `Bearer ${registration.token}`

// Load ship and market data
const ship = ((await axios.get('/my/ships?limit=20')).data.data)[0]
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
const graph = {}
for(const a of market_waypoints) {
    for (const b of market_waypoints) {
        const distance = Math.round(Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2))
        graph[a.symbol] = graph[a.symbol] ?? {}
        if (distance <= ship.fuel.capacity)
            graph[a.symbol][b.symbol] = Math.round(distance * 25/15 + 15)
    }
}
async function goto_waypoint(waypointSymbolTarget) {
    for (const waypointSymbol of dijkstra.find_path(graph, ship.nav.waypointSymbol, waypointSymbolTarget).slice(1)) {
        await dock()
        if (ship.fuel.capacity != ship.fuel.current)
            await axios.post(`/my/ships/${ship.symbol}/refuel`, { units: ship.fuel.capacity - ship.fuel.current })
        await orbit()
        const { fuel, nav } = (await axios.post(`/my/ships/${ship.symbol}/navigate`, { waypointSymbol })).data.data
        ship.fuel = fuel; ship.nav = nav
        await sleep(new Date(ship.nav.route.arrival) - Date.now() + 1000)
    }
}
const dock = async () => ship.nav.status !== 'DOCKED' && (ship.nav = (await axios.post(`/my/ships/${ship.symbol}/dock`)).data.data.nav)
const orbit = async () => ship.nav.status !== 'IN_ORBIT' && (ship.nav = (await axios.post(`/my/ships/${ship.symbol}/orbit`)).data.data.nav)
async function buy_good(symbol, units) {
    await dock()
    ship.cargo = (await axios.post(`/my/ships/${ship.symbol}/purchase`, { symbol, units })).data.data.cargo
}
async function sell_good(symbol, units) {
    await dock()
    ship.cargo = (await axios.post(`/my/ships/${ship.symbol}/sell`, { symbol, units })).data.data.cargo
}
const credits = async () => (await axios.get('/my/agent')).data.data.credits
const sleep = async (ms) => { console.log('sleeping', ms); return new Promise(resolve => setTimeout(resolve, ms)) }
async function update_market() {
    const market = (await axios.get(`/systems/${ship.nav.systemSymbol}/waypoints/${ship.nav.waypointSymbol}/market`)).data.data
    market.timestamp = Date.now()
    fs.writeFileSync(`${data_dir}/local-market-${ship.nav.waypointSymbol}.json`, JSON.stringify(market, null, 2))
    market_waypoints.find(w => w.symbol == ship.nav.waypointSymbol).market_local = market
}

// Main loop: Execute trades + update prices
await sleep(new Date(ship.nav.route.arrival) - Date.now() + 1000)
while (true) {
    if (ship.cargo.units == 0) {
        const requires_update = market_waypoints.filter(w => w.market_remote.imports.length != 0 && (w.market_local?.timestamp ?? 0) < Date.now() - 6 * 60 * 60 * 1000)
            .sort((a, b) => (a.x - ship.nav.route.destination.x) ** 2 + (a.y - ship.nav.route.destination.y) ** 2 - (b.x - ship.nav.route.destination.x) ** 2 - (b.y - ship.nav.route.destination.y) ** 2)
        if (requires_update.length > 0) {
            console.log('Updating', requires_update[0].symbol, 'at', requires_update[0].x, requires_update[0].y)
            await goto_waypoint(requires_update[0].symbol)
            await update_market()
        } else {
            const cur_credits = await credits()
            let trade = { profit: 0 }
            for (const a of market_waypoints) {
                for (const b of market_waypoints) {
                    for (const good of a.market_local?.tradeGoods ?? []) {
                        const good1 = b.market_local?.tradeGoods.find(g => g.symbol == good.symbol)
                        if (!good1) continue
                        const units = Math.min(ship.cargo.capacity, good.tradeVolume, good1.tradeVolume)
                        const profit = units * (good1.sellPrice - good.purchasePrice)
                        if (profit > trade.profit && good.purchasePrice * units + 5000 <= cur_credits) {
                            trade = { profit, src: a.symbol, dest: b.symbol, symbol: good.symbol, units }
                        }
                    }
                }
            }
            if (trade.profit <= 1000) {
                console.log('No trades available')
                await sleep(1000 * 60)
                continue
            }
            console.log('best trade:', trade)
            fs.writeFileSync(`${data_dir}/trade.json`, JSON.stringify(trade, null, 2))
            await goto_waypoint(trade.src)
            await buy_good(trade.symbol, trade.units)
        }
    } else {
        const trade = JSON.parse(fs.readFileSync(`${data_dir}/trade.json`))
        await goto_waypoint(trade.dest)
        await sell_good(trade.symbol, trade.units) // todo: handle falling TV
    }
}
