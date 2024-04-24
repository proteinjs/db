# Setup

1. Install docker
2. Create and start mysql container: `docker run -p 127.0.0.1:3306:3306  --name mdb -e MARIADB_ALLOW_EMPTY_ROOT_PASSWORD=TRUE -d mariadb:latest`
3. (optional) Connect to mysql cli: `docker exec -it mdb mariadb --user root`