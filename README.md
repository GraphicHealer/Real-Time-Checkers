# Extra Dimensional Real-Time-Checkers (RTC, Get it? :D)
This is a proof of concept game I made using ChatGPT, Claude, and my own code.
It is Checkers, but you can move in 3D (Multiple Layers)!

## Running
Drop the contents of the `web/` folder into a web server and host them

Put `signaling-server.js` onto a NodeJS server, and change the port to what you need.

Edit the `WS_URL` variable in the `Config` section in the HTML file to point to the NodeJS Websocket URL.

Open the website, you should see the Checkers game!
