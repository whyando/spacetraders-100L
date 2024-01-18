/// WIP

import axios from 'axios'
import fs from 'fs'
import dijkstra from 'dijkstrajs'

// add axios interceptors to log requests
axios.interceptors.response.use(response => {
    console.log(`${response.status} ${response.config.method.toUpperCase()} ${response.config.url}`)
    return response
})

// Config
axios.defaults.baseURL = 'https://api.spacetraders.io/v2/'
const FACTION = 'ASTRO'
const CALLSIGN = '100L-5'

// Setup phase: data directory + agent registration
const status = (await axios.get('/')).data
const data_dir = `./data/${status.resetDate}/${CALLSIGN}`
if (!fs.existsSync(data_dir)) fs.mkdirSync(data_dir, { recursive: true })

if (!fs.existsSync(`${data_dir}/registration.json`)) {
    const registration = (await axios.post('/register', { faction: FACTION, symbol: CALLSIGN })).data.data
    fs.writeFileSync(`${data_dir}/registration.json`, JSON.stringify(registration, null, 2))
}
const registration = JSON.parse(fs.readFileSync(`${data_dir}/registration.json`))
axios.defaults.headers.common['Authorization'] = `Bearer ${registration.token}`

// Load agent, ship, system and market data
// const agent = (await axios.get('/my/agent')).data.data
const ships = (await axios.get('/my/ships?limit=20')).data.data
fs.writeFileSync(`${data_dir}/ships.json`, JSON.stringify(ships, null, 2))
// const system = (await axios.get(`/systems/${ships[0].nav.systemSymbol}`)).data.data
const market_waypoints = [...(await axios.get(`/systems/${ships[0].nav.systemSymbol}/waypoints?traits=MARKETPLACE&limit=20`)).data.data,
    ...(await axios.get(`/systems/${ships[0].nav.systemSymbol}/waypoints?traits=MARKETPLACE&page=2&limit=20`)).data.data]
for (const w of market_waypoints) {
    if (!fs.existsSync(`${data_dir}/remote-market-${w.symbol}.json`)) {
        const data = (await axios.get(`/systems/${ships[0].nav.systemSymbol}/waypoints/${w.symbol}/market`)).data.data
        fs.writeFileSync(`${data_dir}/remote-market-${w.symbol}.json`, JSON.stringify(data, null, 2))
    }
    w.market_remote = JSON.parse(fs.readFileSync(`${data_dir}/remote-market-${w.symbol}.json`))
    try { w.market_local = JSON.parse(fs.readFileSync(`${data_dir}/local-market-${w.symbol}.json`)) } catch (e) {}
}
const graph = {}
for(const a of market_waypoints) {
    for (const b of market_waypoints) {
        const distance = Math.round(Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2))
        const duration = Math.round(distance * 25/15 + 15)
        graph[a.symbol] = graph[a.symbol] ?? {}
        if (distance <= ships[0].fuel.capacity)
            graph[a.symbol][b.symbol] = duration
    }
}
async function goto_waypoint(ship, waypointSymbol) {
    const path = dijkstra.find_path(graph, ship.nav.waypointSymbol, waypointSymbol).slice(1)    
    for (const waypointSymbol of path) {
        await dock(ship)
        if (ship.fuel.capacity != ship.fuel.current)
            await axios.post(`/my/ships/${ship.symbol}/refuel`, { units: ship.fuel.capacity - ship.fuel.current })
        await navigate(ship, waypointSymbol)
    }
}
const dock = async ship => ship.nav.status !== 'DOCKED' && (ship.nav = (await axios.post(`/my/ships/${ship.symbol}/dock`)).data.data.nav)
const orbit = async ship => ship.nav.status !== 'IN_ORBIT' && (ship.nav = (await axios.post(`/my/ships/${ship.symbol}/orbit`)).data.data.nav)
async function navigate(ship, waypointSymbol) {
    // if (!ship.nav.status !== 'IN_ORBIT')
    //     ship.nav = (await axios.post(`/my/ships/${ship.symbol}/orbit`)).data.data.nav
    await orbit(ship)
    const { fuel, nav } = (await axios.post(`/my/ships/${ship.symbol}/navigate`, { waypointSymbol })).data.data
    ship.fuel = fuel; ship.nav = nav
    await new Promise(r => setTimeout(r, new Date(ship.nav.route.arrival) - Date.now() + 1000))    
    // @@ -> IN_ORBIT ?
}
async function update_market(ship) {
    const market = (await axios.get(`/systems/${ship.nav.systemSymbol}/waypoints/${ship.nav.waypointSymbol}/market`)).data.data
    market.timestamp = Date.now()
    fs.writeFileSync(`${data_dir}/local-market-${ship.nav.waypointSymbol}.json`, JSON.stringify(market, null, 2))
    market_waypoints.find(w => w.symbol == ship.nav.waypointSymbol).market_local = market
    // @@ refuel?
}

// Main loop: Execute trades + update prices
await new Promise(r => setTimeout(r, new Date(ships[0].nav.route.arrival) - Date.now() + 1000))
while (true) {
    if (ships[0].cargo.units == 0) {
        // get markets that haven't been visited within 3 hours
        const requires_update = market_waypoints.filter(w => w.market_remote.imports.length != 0 && (w.market_local?.timestamp ?? 0) < Date.now() - 3 * 60 * 60 * 1000)
            .sort((a, b) => (a.x - ships[0].nav.route.destination.x) ** 2 + (a.y - ships[0].nav.route.destination.y) ** 2 - (b.x - ships[0].nav.route.destination.x) ** 2 - (b.y - ships[0].nav.route.destination.y) ** 2)
        if (false && requires_update.length > 0) {
            console.log('Updating', requires_update[0].symbol, 'at', requires_update[0].x, requires_update[0].y)
            await goto_waypoint(ships[0], requires_update[0].symbol)
            await update_market(ships[0])
        } else {
            // market_waypoints.filter(w => w.market_remote.imports.length != 0).map(

            // Find the waypoint, waypoint, good tuple such that the following is maximised:
            // = buy_quantity * (sell_price - buy_price) 
            // quantity = min(capacity, buy_trade_volume * 2, sell_trade_volume * 2)
            for (const a of market_waypoints) {
                for (const b of market_waypoints) {
                    for (const good of a.market_local?.tradeGoods ?? []) {

                        console.log(good)
                    }
                }
            }
            throw Error('@@ buy logic todo')
        }
    } else {
        throw Error('@@ sell logic todo')
        // Find the waypoint, waypoint, good tuple such that the following is maximised:
        // = sell_price
        // !! actually.. load initial plan
    }
}