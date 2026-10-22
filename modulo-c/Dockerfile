FROM golang:1.21-alpine

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY . .

RUN go build -o modulo-c .

EXPOSE 6000

CMD ["./modulo-c"]
