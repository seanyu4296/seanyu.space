---
title: Stop and Go — Regulating goroutines with a traffic light
date: "2022-11-01T22:40:32.169Z"
template: "post"
draft: false
slug: "regulating-goroutines-with-a-traffic-light"
category: "Golang"
tags:
  - "Concurrency"
  - "Golang"
description: "In Go, you can control the number of concurrent goroutines running based on your needs by using a buffered channel as a semaphore."
socialImage: "/media/gophers-bridge-stop.webp"
---
> _In Go, you can control the number of concurrent goroutines running based on your needs by using a buffered channel as a semaphore_

![](https://miro.medium.com/max/1400/1*48aVAfve_SwN7Ijm3cHxJw.jpeg)

## Context: Batch Jobs

In Xendit, there are a ton of cron jobs running to process batch work in a deterministic interval fashion. One of the cron job’s work is to synchronize payment statuses, successful or not, by doing an HTTP call to our bank partners. Simplifying for this purpose, the code goes like this:

```go
func job() {
	ctx := context.Background()
	payments := paymentService.FetchPaymentsToRecon(ctx)
	for _, payment := range payments {
		result, err := thirdPartyService.CheckPaymentStatus(ctx, payment.ID)
		if err != nil {
			paymentService.MarkPaymentAsFailed(ctx, payment.ID)
		}
		if result.Status == "SUCCESS" {
			paymentService.MarkPaymentAsSuccess(ctx, payment.ID)
		}
		// Do nothing
	}
}
```

## Problem: Scalability Issue

One morning, our team got alerted that some payments were not being synchronized in time. Some of my colleagues found out that it was due to the cron job reaching its set maximum duration to run. In this case, it was reaching the set  `**activeDeadlineSeconds**`  for k8s  `CronJob`  resource. Digging deeper, we discovered that the delay was  caused by an influx of payments as it was payday and a sudden spike of latency from the third-party service API.

> **_In short, It was an unexpected scalability issue on our end given the higher volume and spike in latency of third party services._**

## Naive Solution

First, naive attempt was to increase the  `**activeDeadlineSeconds**`  / max running duration of our cron job, which would cause longer latency for payments to be synchronized, which might impact user experience.

A naive solution was to spin up as much goroutine as needed to increase scalability and maximize our server resources. It goes something like below. Just fire as much goroutine as needed 🚀

```go
func job() error {
	ctx := context.Background()
	payments := paymentService.FetchPaymentsToRecon(ctx)
	for _, payment := range payments {
		go func(p Payment) {
			result, err := thirdPartyService.CheckPaymentStatus(ctx, p.ID)
			if err != nil {
				paymentService.MarkPaymentAsFailed(ctx, p.ID)
			}
			if result.Status == "SUCCESS" {
				paymentService.MarkPaymentAsSuccess(ctx, p.ID)
			}
		}(payment)
	}
}
```

The above has the following flaws:

1.  Our code above  **does not wait for all work/goroutines to be done**  before exiting the process
2.  Our code above  **does not consider the load capacity of downstream services**. We have no control over 3rd party’s maximum server capacity, so we have to control the load we send to them.

## Guide Questions

Let’s convert the flaws to these questions to give us a compass in implementing a solution:

1.  How do we wait for all goroutines to be finished before the process exits?
2.  How do we limit the number of concurrent goroutines/requests running?

### Question 1: How do we wait for all goroutines to be finished before the process exits?

A quick answer to this is using  `wg.WaitGroup`  . It is a very convenient utility to  **“wait” given a number of “tasks” needed to be done**. Let’s quickly see below:

```go
func main() {
	ctx := context.Background()
	payments := paymentService.FetchPaymentsToRecon(ctx)
	// Initialize a WaitGroup
	wg := sync.WaitGroup{}
	// Give a number of tasks to "complete" in this case number of payments
	wg.Add(len(payments))
	for _, payment := range payments {
		go func(p Payment) {
			result, err := thirdPartyService.CheckPaymentStatus(ctx, p.ID)
			if err != nil {
				paymentService.MarkPaymentAsFailed(ctx, p.ID)
			}
			if result.Status == "SUCCESS" {
				paymentService.MarkPaymentAsSuccess(ctx, p.ID)
			}
			// Mark as "task" done
			wg.Done()
		}(payment)
	}
	// This waits until everything is done
	wg.Wait()
}
```

Done!

If you are up for a challenge, you can also use go channels to do so. 👀 See the end of the post to see how

### Question 2: Limiting # of running concurrent goroutines

There is an abstract data type called semaphore in concurrent programming we can use. Quoting from Wikipedia:

> Semaphore is a variable or abstract data type used to control access to a common resource by multiple processes in a concurrent system such as a multitasking operating system.

“Multiple processes” in this case are concurrently running goroutines. A semaphore can be a common resource for goroutines to refer to to behave in some desired fashion based on our needs. For this case, we can use a semaphore to limit the number of goroutines doing “active work” by controlling when a specific goroutine should do “active work”. Active work in this case, see below, is calling downstream services and doing updates to the payment

```go
func work(p Payment) {
	result, err := thirdPartyService.CheckPaymentStatus(ctx, payment.ID)
	if err != nil {
		paymentService.MarkPaymentAsFailed(ctx, payment.ID)
	}
	if result.Status == "SUCCESS" {
		paymentService.MarkPaymentAsSuccess(ctx, payment.ID)
	}
}
```

Let’s say we want only 10 max concurrent requests, but we have 11 payments. We spin up a goroutine for each payment. What a semaphore needs to do is to not let the 11th goroutine do its work yet, until one goroutine finishes.

```go
// relevant code
for _, payment := range payments {
	go func(p Payment) {
		// !!! Just run this "seq of work" 10 at a time !!! but how??
		work(p Payment)
	}(payment)
}


func work(p Payment) {
	// ...
}
```

We can use go’s  **buffered channel**  as a semaphore. We leverage a buffered channel’s characteristic of being “blocking” on the sender’s end when the channel reaches its max length or capacity. Example:

```go
// Buffered channel showcase
func main() {
	bufferedChann := make(chan int, 3)
	bufferedChann <- 1
	bufferedChann <- 2
	bufferedChann <- 3
	// Below is stuck  except if we write above `<- bufferedChann`
	bufferedChann <- 4
}
```
(Note: above will be detected as a deadlock by go if you try to run it)

We can then modify our code to the below. I marked new lines of code with  `NEW:`

```go
// FINAL SOLUTION:
const MAX_CONCURRENT_WORK = 10 // input your desired count
func main() {
	ctx := context.Background()
	payments := paymentService.FetchPaymentsToRecon(ctx)

	// NEW: Adding a buffered channel here as a our semaphore
	semaphore := make(chan struct{}, MAX_CONCURRENT_WORK)
	wg := sync.WaitGroup{}
	wg.Add(len(payments))
	for _, payment := range payments {
		// NEW:
		// Idea: Goroutine checks semaphore if it can start doing its work
		// This will "block" if the buffered channel is full
		// This will "continue" and "reserve a slot" if buffered channel is not full
		semaphore <- struct{}{}
		go func(p Payment) {
			{
				// Unit of work
				work(p)
			}
			// NEW: Goroutine gives back the slot to others
			wg.Done()
			<- semaphore
		}(payment)
	}
}
func work(p Payment) {
	result, err := thirdPartyService.CheckPaymentStatus(ctx, payment.ID)
	if err != nil {
		paymentService.MarkPaymentAsFailed(ctx, payment.ID)
	}
	if result.Status == "SUCCESS" {
		paymentService.MarkPaymentAsSuccess(ctx, payment.ID)
	}
}
```
## Bonus: Implementing it as a Generic Function

To solidify our understanding of this pattern, we can try to create a “generic function” for learning purposes or for re-use if you think that’s best for your team and codebase.

Here is the code. You can run code below in  [https://go.dev/play/p/oOk489XFQBk](https://go.dev/play/p/oOk489XFQBk)

```go
func main() {
	items := []string{"test", "test2", "test3", "test4"}
	ProcessConcurrentWork(context.Background(), 2, items,
		func(ctx context.Context, s string) {
			time.Sleep(1 * time.Millisecond)
			fmt.Println(s)
		})
}

func ProcessConcurrentWork[T any](
	ctx context.Context,
	workerCount int,
	items []T,
	processFunc func(ctx context.Context, item T),
) {
	itemCount := len(items)
	semaphore := make(chan struct{}, workerCount)
	wg := sync.WaitGroup{}
	wg.Add(itemCount)
	for _, item := range items {
		semaphore <- struct{}{}
		go func(i T) {
			{
				processFunc(ctx, i)
			}
			wg.Done()
			<-semaphore
		}(item)
	}
	wg.Wait()
}
```
## Question 1 Challenge: Using go channels to wait for

We can use a go channel as a medium for communication from the running goroutines to the main function. A goroutine sends a signal to the channel when it’s done processing its work.  `main`  the function waits for X signals based on the number of works before it exists.

```go
func main() {
	ctx := context.Background()
	payments := paymentService.FetchPaymentsToRecon(ctx)
	if err != nil {
		return err
	}
	// Go channel
	numOfPayments := len(payments)
	waitChann := make(chan struct{})
	for _, payment := range payments {
		go func(p Payment) {
			work(p)
			waitChann <- struct{}{}
		}(payment)
	}
	// This waits until everything is done
	for numOfPayments > 0 {
		<-waitChann
		numOfPayments--
	}
	fmt.Println("Done")
}
```

_Published also on [Medium](https://medium.com/xendit-engineering/stop-and-go-regulating-goroutines-with-a-traffic-light-2e416d349b1e)._
